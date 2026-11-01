// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Sprint close surveys the whole pending next-step ledger without asserting delivery.
// ABOUTME: A failed survey is unavailable, and a rejected mandatory context write rolls back.

/**
 * Sprint 90 m05 replaces the provenance-as-delivery UPDATE with a read-only whole-ledger survey.
 * This file keeps both database-forced halves of the old disclosure gate, aimed at the behavior
 * that survives:
 *
 *   (a) WRITE failure — `project_context` is made non-vacuously dirty, then a
 *       `BEFORE UPDATE OF content ON contexts WHEN OLD.id='project_context'` trigger rejects the
 *       mandatory persist. The close must fail and roll back the sprint, contexts, next_steps,
 *       snapshots, archival, and event state.
 *   (b) READ failure — renaming `next_steps.mission_id` breaks exactly the survey projection.
 *       The close may proceed, but the survey must say unavailable with a named warning. A null
 *       total is load-bearing: a failed read must never look like an empty ledger.
 *
 * Failures are forced in SQLite, never with a mock client. Lazy migrations run before either
 * forcing is installed because the firehose migration can rebuild `next_steps`.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { withClient } from '../../../src/tools/rbook/client';
import {
  rbookSprintComplete,
  formatSprintCompleteForLLM,
} from '../../../src/tools/rbook/rbook-sprint-complete';
import type { RbookSprintCompleteResult } from '../../../src/tools/rbook/rbook-sprint-complete';
import {
  ensureAuthorNamespaceColumns,
  ensureFirehoseEventColumns,
} from '../../../src/tools/rbook/schema-migrations';
import type { RbookToolResult } from '../../../src/tools/rbook/types';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

const CLOSING_SPRINT = 'sprint-86';
const OTHER_SPRINT = 'sprint-87';
const TRIGGER_MESSAGE = 'forced project_context content UPDATE failure';
const PROJECT_CONTEXT_TRIGGER = 'force_project_context_content_update_fail';

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface SeededStore {
  readonly projectRoot: string;
  readonly dbPath: string;
}

async function buildStore(prefix: string): Promise<SeededStore> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(projectRoot);
  const dbPath = seedRbookDb(projectRoot, { projectName: 's90-m05 sprint close' });
  reidentifyRbookTestStore(projectRoot);

  const createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const startDate = createdAt.slice(0, 10);

  const db = new Database(dbPath);
  try {
    const insertSprint = db.prepare(
      `INSERT INTO sprints (id, title, focus, status, start_date) VALUES (?, ?, ?, 'Active', ?)`
    );
    insertSprint.run(CLOSING_SPRINT, 'Sprint 86', 'Say only what you know', startDate);
    insertSprint.run(OTHER_SPRINT, 'Sprint 87', 'Not closing', startDate);

    const insertMission = db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    insertMission.run('s86-m01', CLOSING_SPRINT, 'Mission m01', 'Completed', null, createdAt);
    insertMission.run('s86-m02', CLOSING_SPRINT, 'Mission m02', 'Completed', null, createdAt);
    insertMission.run(
      's86-m03',
      CLOSING_SPRINT,
      'Mission m03',
      'Blocked',
      '[Blocked] waiting on upstream',
      createdAt
    );

    const insertStep = db.prepare(
      `INSERT INTO next_steps (id, content, status, sprint_id, mission_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    insertStep.run(1, 'wrap up s86-m01', 'pending', CLOSING_SPRINT, 's86-m01', createdAt);
    insertStep.run(2, 'wrap up s86-m02', 'pending', CLOSING_SPRINT, 's86-m02', createdAt);
    insertStep.run(3, 'blocked follow-up', 'pending', CLOSING_SPRINT, 's86-m03', createdAt);
    insertStep.run(4, 'free-text idea, did it ship?', 'pending', CLOSING_SPRINT, null, createdAt);
    insertStep.run(5, 'work for the next sprint', 'pending', OTHER_SPRINT, null, createdAt);

    db.prepare(`UPDATE contexts SET content = ? WHERE id = 'master_context'`).run(
      JSON.stringify({
        next_session_context: {
          when_we_resume: Array.from(
            { length: 16 },
            (_, index) => `Keep future s86-m01 prose ${index}`
          ),
        },
      })
    );
    db.prepare(`UPDATE contexts SET content = ? WHERE id = 'project_context'`).run(
      JSON.stringify({
        working_memory: {
          session_history: [{ id: 's86-session' }],
          next_steps: ['Keep future s86-m01 prose'],
        },
        current_sprint: CLOSING_SPRINT,
        active_mission: 's86-m01',
      })
    );
    db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
       VALUES ('Archive only if the close commits', ?, ?, 'active')`
    ).run(createdAt, CLOSING_SPRINT);
  } finally {
    db.close();
  }

  await withClient(
    (client) => {
      ensureFirehoseEventColumns(client);
      ensureAuthorNamespaceColumns(client);
      return { success: true as const, data: null };
    },
    { projectRoot }
  );

  return { projectRoot, dbPath };
}

function readStep(dbPath: string, id: number): { status: string; resolved_at: string | null } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT status, resolved_at FROM next_steps WHERE id = ?').get(id) as {
      status: string;
      resolved_at: string | null;
    };
  } finally {
    db.close();
  }
}

function readScalar<T>(dbPath: string, sql: string): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(sql).get() as { value: T };
    return row.value;
  } finally {
    db.close();
  }
}

function objectExists(dbPath: string, type: 'trigger', name: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name = ?`).get(type, name) !==
      undefined
    );
  } finally {
    db.close();
  }
}

function nextStepsColumns(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('PRAGMA table_info(next_steps)').all() as Array<{ name: string }>).map(
      (column) => column.name
    );
  } finally {
    db.close();
  }
}

/**
 * s92-m05: archival is opt-in since 3.2.0. These closes opt in so that (a)'s rollback still
 * covers a close that archives — on a default close the decision would read `active` either way.
 */
async function closeSprint(
  projectRoot: string,
  summary: string
): Promise<{ result: RbookToolResult<RbookSprintCompleteResult>; text: string }> {
  const result = await rbookSprintComplete({
    sprintId: CLOSING_SPRINT,
    summary,
    archive: true,
    projectRoot,
  });
  return { result, text: formatSprintCompleteForLLM(result) };
}

describe('s90-m05 sprint-close survey and mandatory-write disclosure', () => {
  it('BASELINE — surveys every pending row and never changes next_steps status', async () => {
    const { projectRoot, dbPath } = await buildStore('rbook-m05-close-baseline-');

    const { result, text } = await closeSprint(projectRoot, 'baseline close');

    expect(result.success).toBe(true);
    const data = result.data as RbookSprintCompleteResult;
    expect(data.nextStepsSurvey.available).toBe(true);
    expect(data.nextStepsSurvey.totalPending).toBe(5);
    expect(data.nextStepsSurvey.groups?.closingSprintWithMissionProvenance).toHaveLength(3);
    expect(data.nextStepsSurvey.groups?.closingSprintWithoutMissionProvenance).toHaveLength(1);
    expect(data.nextStepsSurvey.groups?.otherSprintProvenance).toHaveLength(1);
    expect(data.nextStepsSurvey.groups?.noSprintProvenance).toHaveLength(0);

    for (const id of [1, 2, 3, 4, 5]) {
      expect(readStep(dbPath, id)).toEqual({ status: 'pending', resolved_at: null });
    }
    expect(data.writeFailures).toEqual([]);
    expect(text).toContain('Next-steps survey: 5 pending across the whole ledger');
    expect(text).not.toContain('auto-completed');
    expect(
      readScalar<string>(
        dbPath,
        `SELECT status AS value FROM strategic_decisions WHERE decision_text = 'Archive only if the close commits'`
      )
    ).toBe('archived');
  });

  it('(a) a rejected mandatory project_context persist fails and rolls back every transactional write', async () => {
    const { projectRoot, dbPath } = await buildStore('rbook-m05-close-context-fail-');
    const beforeProjectContext = readScalar<string>(
      dbPath,
      `SELECT content AS value FROM contexts WHERE id = 'project_context'`
    );
    const beforeMasterContext = readScalar<string>(
      dbPath,
      `SELECT content AS value FROM contexts WHERE id = 'master_context'`
    );

    const db = new Database(dbPath);
    try {
      // s91-m06: a row past the lease line, so the close's in-transaction `dropped` write is one
      // of the writes the rejected persist must roll back. The store is already migrated, so the
      // genesis columns are copied from an existing row with fresh event ids.
      const day = 24 * 60 * 60 * 1000;
      [40, 30, 20, 10].forEach((ago, n) => {
        db.prepare(
          `INSERT INTO sprints (id, title, status, end_date, project_id, stable_event_id,
             occurred_at, origin_seq, event_type, schema_version)
           SELECT ?, ?, 'Completed', ?, project_id, ?, occurred_at, origin_seq + 100 + ?,
             event_type, schema_version FROM sprints WHERE id = ?`
        ).run(
          `sprint-lease-${ago}`,
          `Lease ${ago}`,
          new Date(Date.now() - ago * day).toISOString(),
          `01S91M06LEASESPRINT0000000${n}`,
          n,
          CLOSING_SPRINT
        );
      });
      db.prepare(
        `INSERT INTO next_steps (id, content, status, created_at, project_id, stable_event_id,
           occurred_at, origin_seq, event_type, schema_version)
         SELECT 6, 'lapsed row', 'pending', ?, project_id, '01S91M06LEASESTEP000000006',
           occurred_at, origin_seq + 100, event_type, schema_version FROM next_steps WHERE id = 1`
      ).run(new Date(Date.now() - 50 * day).toISOString());
      db.exec(
        `CREATE TRIGGER ${PROJECT_CONTEXT_TRIGGER}
         BEFORE UPDATE OF content ON contexts
         WHEN OLD.id = 'project_context'
         BEGIN SELECT RAISE(ABORT, '${TRIGGER_MESSAGE}'); END;`
      );
    } finally {
      db.close();
    }

    const { result, text } = await closeSprint(projectRoot, 'close with rejected context persist');

    expect(objectExists(dbPath, 'trigger', PROJECT_CONTEXT_TRIGGER)).toBe(true);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_QUERY_FAILED');
    expect(result.error?.message).toContain(TRIGGER_MESSAGE);
    expect(text).toContain(TRIGGER_MESSAGE);

    expect(
      readScalar<string>(
        dbPath,
        `SELECT status AS value FROM sprints WHERE id = '${CLOSING_SPRINT}'`
      )
    ).toBe('Active');
    expect(
      readScalar<string>(
        dbPath,
        `SELECT content AS value FROM contexts WHERE id = 'project_context'`
      )
    ).toBe(beforeProjectContext);
    expect(
      readScalar<string>(
        dbPath,
        `SELECT content AS value FROM contexts WHERE id = 'master_context'`
      )
    ).toBe(beforeMasterContext);
    expect(
      readScalar<string>(
        dbPath,
        `SELECT status AS value FROM strategic_decisions WHERE decision_text = 'Archive only if the close commits'`
      )
    ).toBe('active');
    expect(
      readScalar<number>(
        dbPath,
        `SELECT COUNT(*) AS value FROM session_events WHERE action = 'sprint_complete'`
      )
    ).toBe(0);
    expect(readScalar<number>(dbPath, `SELECT COUNT(*) AS value FROM context_snapshots`)).toBe(0);
    // Including #6, which the lease would have dropped had the close committed.
    for (const id of [1, 2, 3, 4, 5, 6]) {
      expect(readStep(dbPath, id)).toEqual({ status: 'pending', resolved_at: null });
    }
  });

  it('(b) a failed mission_id projection reports an unavailable survey, never a false zero', async () => {
    const { projectRoot, dbPath } = await buildStore('rbook-m05-close-survey-fail-');

    const db = new Database(dbPath);
    try {
      db.exec('ALTER TABLE next_steps RENAME COLUMN mission_id TO mission_id_hidden');
    } finally {
      db.close();
    }

    const { result, text } = await closeSprint(projectRoot, 'close with unreadable next_steps');

    expect(nextStepsColumns(dbPath)).toContain('mission_id_hidden');
    expect(nextStepsColumns(dbPath)).not.toContain('mission_id');
    expect(result.success).toBe(true);
    expect(
      readScalar<string>(
        dbPath,
        `SELECT status AS value FROM sprints WHERE id = '${CLOSING_SPRINT}'`
      )
    ).toBe('Completed');

    const data = result.data as RbookSprintCompleteResult;
    expect(data.nextStepsSurvey).toEqual({
      available: false,
      totalPending: null,
      // s91-m06: the additive keys are null too — a failed read never looks like an empty ledger.
      totalOpen: null,
      groups: null,
      lease: null,
      // s108-m02: and the waiting rows.
      waiting: null,
    });
    for (const id of [1, 2, 3, 4, 5]) {
      expect(readStep(dbPath, id)).toEqual({ status: 'pending', resolved_at: null });
    }

    const readWarning = (result.warnings ?? []).find((warning) =>
      warning.includes('next_steps survey unavailable')
    );
    expect(readWarning).toBeDefined();
    expect(readWarning).toContain(CLOSING_SPRINT);
    expect(readWarning).toContain('DB_SCHEMA_MISMATCH');
    expect(readWarning).toContain("Column 'mission_id' does not exist");
    expect(text).toContain('Next-steps survey: unavailable (pending total unknown)');
    expect(text).toContain(`- ${readWarning}`);

    // Negative control: the table and its pending rows are still readable when the renamed
    // provenance column is not projected. The failure belongs to the survey shape, not a missing
    // table or empty ledger.
    expect(
      readScalar<number>(
        dbPath,
        `SELECT COUNT(*) AS value FROM next_steps WHERE status = 'pending'`
      )
    ).toBe(5);
  });
});
