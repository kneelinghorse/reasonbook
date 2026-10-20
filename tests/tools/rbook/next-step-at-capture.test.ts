// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s100-m03 (#712) — a next-step capture writes its next_steps row when it is captured, so the next-step list
// ABOUTME: shows it while the session is still open; the close writes only captures that have no row, never a second.

/**
 * Sprint 97's build chat captured 12 next steps into its implicit session, which stayed open with the
 * chat, so none was a row all sprint: the next-step list, the review and the sprint close could not
 * see them, and the server rightly refused to close another running process's session. A next step is
 * now a row from its capture. The close keeps its (content_hash, session_id) dedup, which makes it
 * idempotent over that row and lets it still write captures made before 4.2.1.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import * as genesis from '../../../src/tools/rbook/genesis-columns';
import { closeOwnImplicitSessions } from '../../../src/tools/rbook/implicit-session-lifecycle';
import { rbookNextSteps } from '../../../src/tools/rbook/rbook-next-steps';
import {
  formatSessionCaptureForLLM,
  rbookSessionCapture,
} from '../../../src/tools/rbook/rbook-session-capture';
import { rbookSessionComplete } from '../../../src/tools/rbook/rbook-session-complete';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { importCopy } from '../../../src/tools/rbook/record-import';
import { replayCheck } from '../../../src/tools/rbook/record-replay';
import { shareRecord } from '../../../src/tools/rbook/record-share';
import { computeContentHash } from '../../../src/tools/rbook/schema-migrations';
import * as sessionOwner from '../../../src/tools/rbook/session-owner';
import {
  processOwnerKey,
  setSessionOwnerForTesting,
  type SessionOwner,
} from '../../../src/tools/rbook/session-owner';
import { prepareForSharing } from '../../../src/tools/rbook/sharing-preconditions';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  withClient,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { onPlace, preShare, zipOf } from '../../helpers/import-copies';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';
import {
  joinedCopy,
  onCopy,
  ownerCopy,
  read,
  recordedState,
  shareExisting,
  syncCopies,
} from '../../helpers/shared-copies';

const SPRINT = 'sprint-m03n';
const NEXT_SPRINT = 'sprint-m03n-next';
const MISSION = 'm03n-m01';

const ownerA: SessionOwner = {
  key: processOwnerKey(process.pid, 1),
  kind: 'process',
  pid: process.pid,
};
const ownerB: SessionOwner = {
  key: processOwnerKey(process.pid, 2),
  kind: 'process',
  pid: process.pid,
};

const roots: string[] = [];
const restores: Array<() => void> = [];

/** A store with an Active sprint and an In Progress mission, created before any write migrates it. */
function buildStore(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s100m03-'));
  roots.push(projectRoot);
  const dbPath = seedRbookDb(projectRoot, { projectName: 's100-m03 fixture' });
  reidentifyRbookTestStore(projectRoot);
  const db = new Database(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sprints (id, title, status, start_date) VALUES (?, ?, 'Active', ?)`
    ).run(SPRINT, 'Next steps at capture', now);
    db.prepare(
      `INSERT INTO sprints (id, title, status, start_date) VALUES (?, ?, 'Planned', ?)`
    ).run(NEXT_SPRINT, 'After that', now);
    db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, started_at) VALUES (?, ?, 'Mission', 'In Progress', ?)`
    ).run(MISSION, SPRINT, now);
  } finally {
    db.close();
  }
  return projectRoot;
}

function query<T>(projectRoot: string, sql: string, ...params: unknown[]): T[] {
  const db = new Database(dbOf(projectRoot), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function run(projectRoot: string, sql: string, ...params: unknown[]): void {
  const db = new Database(dbOf(projectRoot));
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

interface StepRow {
  id: number;
  content: string;
  status: string;
  session_id: string | null;
  sprint_id: string | null;
  mission_id: string | null;
  created_at: string;
  content_hash: string | null;
}

const stepsOf = (projectRoot: string, sessionId: string): StepRow[] =>
  query<StepRow>(
    projectRoot,
    'SELECT id, content, status, session_id, sprint_id, mission_id, created_at, content_hash FROM next_steps WHERE session_id = ? ORDER BY id',
    sessionId
  );

const sessionStatus = (projectRoot: string, sessionId: string): string =>
  query<{ status: string }>(projectRoot, 'SELECT status FROM sessions WHERE id = ?', sessionId)[0]
    .status;

async function captureStep(projectRoot: string, content: string, extra = {}) {
  const captured = await rbookSessionCapture({
    category: 'next-step',
    content,
    projectRoot,
    ...extra,
  });
  expect(captured.success).toBe(true);
  return captured;
}

beforeEach(() => {
  RbookDetector.resetInstance();
  setSessionOwnerForTesting(ownerA);
});

afterEach(() => {
  setSessionOwnerForTesting(null);
  jest.restoreAllMocks();
  while (restores.length > 0) restores.pop()!();
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('s100-m03 — a next step is a row from the moment it is captured', () => {
  it('the next-step list shows it while the capturing session stays open, and the receipt gives its id', async () => {
    const root = buildStore();
    const content = 'Run the move-back test once both machines have 4.2.1';
    const captured = await captureStep(root, content);
    const receipt = captured.data!;

    // The session is still open: nothing has closed it.
    expect(sessionStatus(root, receipt.sessionId)).toBe('active');
    expect(receipt.structuredMaterialization).toEqual({
      target: 'next_steps',
      timing: 'immediate',
      outcome: 'materialized',
    });
    expect(receipt.nextStepId).toEqual(expect.any(Number));
    expect(receipt.writeFailures).toEqual([]);

    // The rule the close applied, applied at capture: an implicit session takes the sprint open for
    // writes; the capture named no mission.
    expect(stepsOf(root, receipt.sessionId)).toEqual([
      {
        id: receipt.nextStepId,
        content,
        status: 'pending',
        session_id: receipt.sessionId,
        sprint_id: SPRINT,
        mission_id: null,
        created_at: receipt.timestamp,
        content_hash: computeContentHash(content, 'next-step'),
      },
    ]);

    const listed = await rbookNextSteps({ nextStepAction: 'list', projectRoot: root });
    expect(listed.success).toBe(true);
    expect(listed.data!.items).toEqual([
      expect.objectContaining({
        id: receipt.nextStepId,
        content,
        status: 'pending',
        sessionId: receipt.sessionId,
      }),
    ]);

    const text = formatSessionCaptureForLLM(captured);
    expect(text).toContain(`Next step ID: #${receipt.nextStepId}`);
    expect(text).toContain('Structured materialization: materialized — immediate → next_steps');
  });

  it("stamps the capture's own mission and sprint on the row, as the close did", async () => {
    const root = buildStore();
    const captured = await captureStep(root, 'Stamp the mission at capture', {
      missionId: MISSION,
    });
    expect(stepsOf(root, captured.data!.sessionId)).toEqual([
      expect.objectContaining({ mission_id: MISSION, sprint_id: SPRINT }),
    ]);
  });

  // The readers critic's round 2: its row references the mission, so a typo failed the write at
  // capture and again at the close, while the receipt said the close would write it.
  it('a missionId that names no mission is refused by name, and opens no session', async () => {
    const root = buildStore();
    const refused = await rbookSessionCapture({
      category: 'next-step',
      content: 'Stamp a mission that is not there',
      missionId: 's100-m99',
      projectRoot: root,
    });
    expect(refused.success).toBe(false);
    expect(refused.error).toMatchObject({
      code: 'MISSION_NOT_FOUND',
      message: "Mission 's100-m99' not found",
    });
    expect(query(root, 'SELECT id FROM next_steps')).toEqual([]);
    expect(query(root, 'SELECT id FROM sessions')).toEqual([]);
  });

  it('a next_steps table that cannot be prepared refuses the capture, loudly, and opens no session', async () => {
    const root = buildStore();
    const real = genesis.ensureGenesisSchema;
    jest.spyOn(genesis, 'ensureGenesisSchema').mockImplementation((client, table) => {
      if (table === 'next_steps') throw new Error('next_steps is locked by another writer');
      real(client, table);
    });
    const refused = await rbookSessionCapture({
      category: 'next-step',
      content: 'Never half-written',
      projectRoot: root,
    });
    expect(refused.success).toBe(false);
    expect(refused.error).toMatchObject({
      code: 'DB_QUERY_FAILED',
      message: 'Next-step schema preparation failed; the next step was not captured.',
    });
    expect(refused.warnings).toEqual(
      expect.arrayContaining(['next_steps is locked by another writer'])
    );
    expect(query(root, 'SELECT id FROM next_steps')).toEqual([]);
    // Prepared before the session is found, so this process's first capture opened none.
    expect(query(root, 'SELECT id FROM sessions')).toEqual([]);
  });

  it('a next step that is empty once its marshalling artifact is removed writes no row, and says why', async () => {
    const root = buildStore();
    const captured = await captureStep(root, '<parameter name="nextSteps">["a"]</parameter>');
    expect(captured.data!.nextStepId).toBeUndefined();
    expect(captured.data!.structuredMaterialization.outcome).toBe('failed');
    expect(captured.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/empty once a marshalling artifact was removed/),
      ])
    );
    expect(query(root, 'SELECT id FROM next_steps')).toEqual([]);
  });

  it('the same next step captured twice in one session is one row', async () => {
    const root = buildStore();
    const first = await captureStep(root, 'Say it once');
    const again = await captureStep(root, 'Say it once');
    expect(again.data!.structuredMaterialization.outcome).toBe('existing');
    expect(again.data!.nextStepId).toBe(first.data!.nextStepId);
    expect(stepsOf(root, first.data!.sessionId)).toHaveLength(1);
  });

  // The readers critic's round 1: a session open long enough to see its own next step done (sprint
  // 97's ran all sprint) captures a recurring step again. The close's one key, the session's row with
  // this text whatever its status, makes it that row (the write-path critic's round 2: a second key
  // let a kept capture be skipped by the close). So the capture says the row is resolved and names
  // the call that opens it again.
  it.each([
    ['complete', 'completed'],
    ['drop', 'dropped'],
  ] as const)(
    'the same next step captured again after its row was %s (%s) is that row, and says how to reopen it',
    async (nextStepAction, resolvedStatus) => {
      const root = buildStore();
      const first = await captureStep(root, 'Re-run the load test');
      const id = first.data!.nextStepId!;
      const resolved = await rbookNextSteps({
        nextStepAction,
        nextStepIds: [id],
        projectRoot: root,
      });
      expect(resolved.data!.affected).toBe(1);
      const again = await captureStep(root, 'Re-run the load test');
      expect(again.data!.structuredMaterialization.outcome).toBe('existing');
      expect(again.data!.nextStepId).toBe(id);
      expect(again.warnings).toEqual(
        expect.arrayContaining([
          `Next step #${id} has this text in this session and is ${resolvedStatus}, so this capture opened nothing. ` +
            `To open it again: rbook_context(action="next_steps", nextStepAction="reopen", nextStepIds=[${id}]).`,
        ])
      );
      const open = async () =>
        (await rbookNextSteps({ nextStepAction: 'list', projectRoot: root })).data!.items!.map(
          (item) => item.id
        );
      expect(await open()).toEqual([]);
      // The call the warning names opens it.
      const reopened = await rbookNextSteps({
        nextStepAction: 'reopen',
        nextStepIds: [id],
        projectRoot: root,
      });
      expect(reopened.data!.affected).toBe(1);
      expect(await open()).toEqual([id]);

      const closed = await rbookSessionComplete({ summary: 'done', projectRoot: root });
      expect(closed.data!.nextStepsExtracted).toBe(0);
      expect(stepsOf(root, first.data!.sessionId).map((row) => [row.id, row.status])).toEqual([
        [id, 'pending'],
      ]);
    }
  );

  it('a re-capture of a resolved step attempts no write, so no failed write can be skipped by the close', async () => {
    const root = buildStore();
    const first = await captureStep(root, 'Done once already');
    await rbookNextSteps({
      nextStepAction: 'complete',
      nextStepIds: [first.data!.nextStepId!],
      projectRoot: root,
    });
    const real = RbookDatabaseClient.prototype.execute;
    jest.spyOn(RbookDatabaseClient.prototype, 'execute').mockImplementation(function (
      this: RbookDatabaseClient,
      sql,
      params
    ) {
      if (/^\s*INSERT INTO next_steps/.test(sql))
        return { success: false, error: { code: 'DB_QUERY_FAILED', message: 'disk I/O error' } };
      return real.call(this, sql, params);
    });
    const again = await captureStep(root, 'Done once already');
    jest.restoreAllMocks();
    expect(again.data).toMatchObject({
      structuredMaterialization: { outcome: 'existing' },
      nextStepId: first.data!.nextStepId,
      writeFailures: [],
    });
    expect(formatSessionCaptureForLLM(again)).not.toContain('its close tries the write again');
  });

  it('a carried row is still open, so the same next step captured again is that row', async () => {
    const root = buildStore();
    const first = await captureStep(root, 'Carried and captured again');
    const carried = await rbookNextSteps({
      nextStepAction: 'carry',
      nextStepIds: [first.data!.nextStepId!],
      carryToSprint: NEXT_SPRINT,
      projectRoot: root,
    });
    expect(carried.data!.affected).toBe(1);
    const again = await captureStep(root, 'Carried and captured again');
    expect(again.data!.structuredMaterialization.outcome).toBe('existing');
    expect(again.data!.nextStepId).toBe(first.data!.nextStepId);
    expect(again.warnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/so this capture opened nothing/)])
    );
    expect(stepsOf(root, first.data!.sessionId).map((row) => row.status)).toEqual(['carried']);
  });
});

describe('s100-m03 — the close keeps the row it finds', () => {
  it('a second close writes no duplicate: an explicit complete finds the row and counts only what it wrote', async () => {
    const root = buildStore();
    const a = await captureStep(root, 'First thing next');
    const b = await captureStep(root, 'Second thing next');
    const sessionId = a.data!.sessionId;

    const closed = await rbookSessionComplete({ summary: 'done', projectRoot: root });
    expect(closed.success).toBe(true);
    expect(closed.data!.writeFailures).toEqual([]);
    // The close wrote nothing: both rows were written when captured.
    expect(closed.data!.nextStepsExtracted).toBe(0);
    expect(stepsOf(root, sessionId).map((row) => [row.id, row.content])).toEqual([
      [a.data!.nextStepId, 'First thing next'],
      [b.data!.nextStepId, 'Second thing next'],
    ]);
  });

  it('the close at process end writes no duplicate either', async () => {
    const root = buildStore();
    const captured = await captureStep(root, 'Carry this past the exit');
    const outcome = await closeOwnImplicitSessions();
    expect(outcome.receipts).toEqual([
      expect.objectContaining({ sessionId: captured.data!.sessionId, closed: true }),
    ]);
    expect(stepsOf(root, captured.data!.sessionId)).toEqual([
      expect.objectContaining({
        id: captured.data!.nextStepId,
        content: 'Carry this past the exit',
      }),
    ]);
  });

  it('a capture made before 4.2.1, with no sprintId or missionId and no row, is written by the close', async () => {
    const root = buildStore();
    const fresh = await captureStep(root, 'Captured on 4.2.1');
    const sessionId = fresh.data!.sessionId;
    // A capture an earlier version made in this session: its blob entry only, in the old shape.
    const [{ captures }] = query<{ captures: string }>(
      root,
      'SELECT captures FROM sessions WHERE id = ?',
      sessionId
    );
    run(
      root,
      'UPDATE sessions SET captures = ? WHERE id = ?',
      JSON.stringify([
        {
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          category: 'next-step',
          content: 'Captured before 4.2.1',
        },
        ...JSON.parse(captures),
      ]),
      sessionId
    );

    const closed = await rbookSessionComplete({
      summary: 'done',
      missionId: MISSION,
      projectRoot: root,
    });
    expect(closed.success).toBe(true);
    expect(closed.data!.nextStepsExtracted).toBe(1);
    const rows = stepsOf(root, sessionId);
    expect(rows).toEqual([
      expect.objectContaining({
        id: fresh.data!.nextStepId,
        content: 'Captured on 4.2.1',
        // Written at capture, with the capture's own (absent) mission: the close stamps only what it writes.
        mission_id: null,
        sprint_id: SPRINT,
      }),
      expect.objectContaining({
        content: 'Captured before 4.2.1',
        mission_id: MISSION,
        sprint_id: SPRINT,
        created_at: closed.data!.completedAt,
      }),
    ]);
  });

  // A row that came from another copy, by an import or a merge, has no hash: the hash is derived per
  // copy (the build-time critic's round 1). Its text is what the hash keys, so it is matched by text.
  it('a row with a NULL content_hash is matched by its text in its own session only, and the close keeps it', async () => {
    const root = buildStore();
    const content = 'Same words as two old rows';
    const sessionId = 'PS-NULL-HASH';
    // Planted before any write migrates the store: an open keyless session, and two rows with these
    // words and no hash, one in no session and one in this session.
    const earlier = (ms: number) => new Date(Date.now() - ms).toISOString();
    run(
      root,
      `INSERT INTO sessions (id, type, title, started_at, status, captures) VALUES (?, 'planning', 'NULL hashes', ?, 'active', '[]')`,
      sessionId,
      earlier(180_000)
    );
    for (const owner of [null, sessionId])
      run(
        root,
        `INSERT INTO next_steps (content, status, session_id, created_at) VALUES (?, 'pending', ?, ?)`,
        content,
        owner,
        earlier(120_000)
      );
    const [inSession] = query<{ id: number }>(
      root,
      'SELECT id FROM next_steps WHERE session_id = ?',
      sessionId
    );
    const captured = await captureStep(root, content, { sessionId });
    expect(captured.data!.structuredMaterialization.outcome).toBe('existing');
    expect(captured.data!.nextStepId).toBe(inSession.id);

    const closed = await rbookSessionComplete({ sessionId, summary: 'done', projectRoot: root });
    expect(closed.success).toBe(true);
    expect(closed.data!.nextStepsExtracted).toBe(0);
    expect(
      query<{ session_id: string | null; content_hash: string | null }>(
        root,
        'SELECT session_id, content_hash FROM next_steps WHERE content = ? ORDER BY id',
        content
      )
    ).toEqual([
      { session_id: null, content_hash: null },
      { session_id: sessionId, content_hash: null },
    ]);
  });
});

describe('s100-m03 — the capture reaches the right store and the right session', () => {
  it('an explicit projectRoot with RBOOK_PROJECT_ROOT unset writes the row in that project', async () => {
    const root = buildStore();
    const cwd = process.cwd();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s100m03-cwd-'));
    roots.push(empty);
    process.chdir(empty);
    const saved = process.env.RBOOK_PROJECT_ROOT;
    delete process.env.RBOOK_PROJECT_ROOT;
    restores.push(() => {
      process.chdir(cwd);
      if (saved !== undefined) process.env.RBOOK_PROJECT_ROOT = saved;
    });

    const captured = await captureStep(root, 'Land in the named project');
    expect(stepsOf(root, captured.data!.sessionId)).toEqual([
      expect.objectContaining({
        id: captured.data!.nextStepId,
        content: 'Land in the named project',
      }),
    ]);
  });

  it("a capture naming another running process's session is refused as a decision's is, and writes no row", async () => {
    const root = buildStore();
    const a = await rbookSessionCapture({
      category: 'context',
      content: 'A works',
      projectRoot: root,
    });
    const sessionA = a.data!.sessionId;
    const before = query(root, 'SELECT captures FROM sessions WHERE id = ?', sessionA);

    setSessionOwnerForTesting(ownerB);
    const refusals = [];
    for (const category of ['decision', 'next-step'] as const) {
      const intrusion = await rbookSessionCapture({
        sessionId: sessionA,
        category,
        content: `B writes a ${category} into A by naming it`,
        projectRoot: root,
      });
      expect(intrusion.success).toBe(false);
      refusals.push(intrusion.error);
    }
    expect(refusals[1]).toEqual(refusals[0]);
    expect(refusals[1]).toMatchObject({ code: 'INVALID_PARAMETER', field: 'sessionId' });
    expect(query(root, 'SELECT id FROM next_steps')).toEqual([]);
    expect(query(root, 'SELECT captures FROM sessions WHERE id = ?', sessionA)).toEqual(before);
  });

  it('a session another process takes between the check and the write lock is refused as a decision capture is', async () => {
    const root = buildStore();
    const a = await rbookSessionCapture({
      category: 'context',
      content: 'A works',
      projectRoot: root,
    });
    const sessionA = a.data!.sessionId;
    const before = query(root, 'SELECT captures FROM sessions WHERE id = ?', sessionA);

    const refusals = [];
    for (const category of ['decision', 'next-step'] as const) {
      // The check before the unit passes; the same check under the write lock finds another owner.
      jest
        .spyOn(sessionOwner, 'heldByAnotherProcess')
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      const raced = await rbookSessionCapture({
        sessionId: sessionA,
        category,
        content: `A ${category} raced by another process`,
        projectRoot: root,
      });
      jest.restoreAllMocks();
      expect(raced.success).toBe(false);
      refusals.push(raced.error);
    }
    expect(refusals[1]).toEqual(refusals[0]);
    expect(refusals[1]!.message).toMatch(/Session is owned by another process$/);
    expect(query(root, 'SELECT id FROM next_steps')).toEqual([]);
    expect(query(root, 'SELECT captures FROM sessions WHERE id = ?', sessionA)).toEqual(before);
  });
});

describe('s100-m03 — through the MCP dispatch boundary', () => {
  it('rbook_session capture returns the id, and rbook_context lists the row while the session is open', async () => {
    const root = buildStore();
    const context = await buildMissionProtocolContext();
    const captured = await executeMissionProtocolTool(
      'rbook_session',
      {
        action: 'capture',
        category: 'next-step',
        content: 'Seen through dispatch',
        projectRoot: root,
      },
      context
    );
    expect(captured.isError).not.toBe(true);
    const data = (captured.structuredContent as { data: { nextStepId: number; sessionId: string } })
      .data;
    expect(data.nextStepId).toEqual(expect.any(Number));
    expect(JSON.stringify(captured.content)).toContain(`Next step ID: #${data.nextStepId}`);

    const listed = await executeMissionProtocolTool(
      'rbook_context',
      { action: 'next_steps', nextStepAction: 'list', projectRoot: root },
      context
    );
    expect(listed.isError).not.toBe(true);
    expect(
      (listed.structuredContent as { data: { items: Array<{ id: number; content: string }> } }).data
        .items
    ).toEqual([expect.objectContaining({ id: data.nextStepId, content: 'Seen through dispatch' })]);
    expect(sessionStatus(root, data.sessionId)).toBe('active');
  });
});

describe('s100-m03 — on a shared copy', () => {
  let fixture: ReplicaFixture;
  beforeEach(() => {
    fixture = replicaFixture('rbook-s100m03-shared-');
    useMachine(fixture.tmp, 'air');
  });
  afterEach(() => fixture.restore());

  /** The owner's store shared as the share step does; its replay base, for the replay check. */
  async function sharedStore(): Promise<{ root: string; base: string }> {
    const root = project(fixture.tmp, 'owner');
    writeUserAuthor('Owner');
    const base = await withClient(
      root,
      (client) => {
        const readiness = prepareForSharing(client);
        if (!readiness.ready) throw new Error(readiness.problems.join(' '));
        return shareRecord(client).replayBase;
      },
      { replicaCheck: false }
    );
    return { root, base };
  }

  it('the row lands in the change log with its capture, and the replay reproduces it', async () => {
    const { root, base } = await sharedStore();

    const captured = await call('rbook_session', {
      action: 'capture',
      category: 'next-step',
      content: 'A step the other copies see',
      projectRoot: root,
    });
    expect(captured.success).toBe(true);
    const nextStepId = captured.data!.nextStepId as number;
    expect(nextStepId).toEqual(expect.any(Number));
    expect(sessionStatus(root, captured.data!.sessionId!)).toBe('active');

    const creates = query<{ txn_id: string; value: string }>(
      root,
      "SELECT txn_id, value FROM record_changes WHERE entity = 'next_steps' AND kind = 'create'"
    );
    expect(creates).toHaveLength(1);
    expect(JSON.parse(creates[0].value)).toMatchObject({
      id: nextStepId,
      content: 'A step the other copies see',
      status: 'pending',
    });
    // One transaction recorded the capture and its row.
    expect(
      query<{ field: string }>(
        root,
        "SELECT field FROM record_changes WHERE txn_id = ? AND entity = 'sessions'",
        creates[0].txn_id
      )
    ).toEqual([expect.objectContaining({ field: 'captures' })]);
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });

  it('a row the store rejects at capture is reported, kept in the capture, and written once by the close', async () => {
    const { root, base } = await sharedStore();
    const real = RbookDatabaseClient.prototype.execute;
    jest.spyOn(RbookDatabaseClient.prototype, 'execute').mockImplementation(function (
      this: RbookDatabaseClient,
      sql,
      params
    ) {
      if (/^\s*INSERT INTO next_steps/.test(sql))
        return { success: false, error: { code: 'DB_QUERY_FAILED', message: 'disk I/O error' } };
      return real.call(this, sql, params);
    });
    const context = await buildMissionProtocolContext();
    const captured = await executeMissionProtocolTool(
      'rbook_session',
      {
        action: 'capture',
        category: 'next-step',
        content: 'Kept for the close',
        projectRoot: root,
      },
      context
    );
    jest.restoreAllMocks();
    const data = (captured.structuredContent as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      structuredMaterialization: { timing: 'immediate', outcome: 'failed' },
      writeFailures: [expect.objectContaining({ op: 'next_steps.insert' })],
    });
    expect(data.nextStepId).toBeUndefined();
    expect(JSON.stringify(captured.content)).toContain(
      `The capture is kept in session ${String(data.sessionId)}; its close tries the write again.`
    );
    expect(query(root, 'SELECT id FROM next_steps')).toEqual([]);
    expect(query(root, "SELECT change_id FROM record_changes WHERE entity = 'next_steps'")).toEqual(
      []
    );

    const closed = await call('rbook_session', {
      action: 'complete',
      summary: 'done',
      projectRoot: root,
    });
    expect(closed.data).toMatchObject({ nextStepsExtracted: 1, writeFailures: [] });
    expect(query(root, 'SELECT content FROM next_steps')).toEqual([
      { content: 'Kept for the close' },
    ]);
    expect(replayCheck(dbOf(root), base).mismatches).toEqual([]);
  });

  it("a member's next step reaches the owner while its session is open, and the member's close adds none", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const content = 'Darryl does this next';
    const captured = await onPlace(fixture.tmp, studio, 'rbook_session', {
      action: 'capture',
      category: 'next-step',
      content,
    });
    await syncCopies(fixture.tmp, studio, owner);
    const listed = await onPlace(fixture.tmp, owner, 'rbook_context', {
      action: 'next_steps',
      nextStepAction: 'list',
    });
    expect(listed.data!.items).toEqual([
      expect.objectContaining({ content, sessionId: captured.data!.sessionId }),
    ]);

    const closed = await onPlace(fixture.tmp, studio, 'rbook_session', {
      action: 'complete',
      summary: 'done',
    });
    expect(closed.data).toMatchObject({ nextStepsExtracted: 0 });
    await syncCopies(fixture.tmp, studio, owner);
    for (const copy of [owner, studio])
      expect(
        read(copy, 'SELECT count(*) AS n FROM next_steps WHERE content = ?', [content])
      ).toEqual([{ n: 1 }]);
    expect(recordedState(studio)).toEqual(recordedState(owner));
  }, 300000);

  // The write-path critic's round 1: a row that arrives by an import carries no per-copy hash, so a
  // close keyed on the hash alone wrote it again, and the copy shared the second one.
  it.each([
    ['next-step', 'next_steps', 'nextStepsExtracted'],
    ['constraint', 'constraints', 'constraintsExtracted'],
  ] as const)(
    "an imported open session's %s is not written again when that session closes",
    async (category, table, count) => {
      const place = await preShare(fixture.tmp);
      const zip = zipOf(fixture.tmp, place);
      const content = `An imported ${category}`;
      const captured = await onPlace(fixture.tmp, zip, 'rbook_session', {
        action: 'capture',
        category,
        content,
      });
      const owner = await shareExisting(fixture.tmp, place.root);
      const applied = await onCopy(fixture.tmp, owner, (client) =>
        importCopy(client, zip.root, { apply: true })
      );
      expect(applied.success).toBe(true);
      // It arrived without its hash, which each copy derives for itself.
      expect(read(owner, `SELECT content_hash FROM ${table} WHERE content = ?`, [content])).toEqual(
        [{ content_hash: null }]
      );

      const closed = await onPlace(fixture.tmp, owner, 'rbook_session', {
        action: 'complete',
        sessionId: captured.data!.sessionId,
        summary: 'Closed where it was imported',
      });
      expect(closed.data).toMatchObject({ [count]: 0 });
      expect(
        read(owner, `SELECT count(*) AS n FROM ${table} WHERE content = ?`, [content])
      ).toEqual([{ n: 1 }]);
    },
    300000
  );
});
