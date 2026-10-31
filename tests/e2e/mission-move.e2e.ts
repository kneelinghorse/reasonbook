// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m08 — rbook_mission(action="move") and parked_missions over real MCP stdio against
// ABOUTME: the BUILT dist/, on a tmpdir COPY of the live store.

/**
 * Sprint 86 m08, through the transport it ships over.
 *
 * WHY THIS EXISTS ALONGSIDE THE HANDLER TESTS. `statusFilter`, `expiresAt` and `agentFeedback`
 * were each declared, handled correctly, and shipped DEAD — nothing reached the handler, because
 * the parameter never made it past the MCP boundary. A new ACTION plus a new PARAMETER is exactly
 * that shape: `rbook_mission`'s root inputSchema is `additionalProperties: false`, so an
 * unpublished `toSprintId` would be REJECTED at the boundary rather than silently ignored, and a
 * handler-only test would never notice.
 *
 * THE STORE IS A COPY. Every leg runs against a tmpdir copy of the live store — a real, migrated
 * schema — and the live store is never opened for writing.
 *
 * NO SILENT FAIL-OPEN. Missing dist/ or private store evidence fails in the private tree. Only a
 * structurally identified public mirror skips, and the shared helper prints the missing evidence
 * and reason instead of letting a positive fire return green vacuously.
 */

import { afterAll, beforeAll, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { requiresPrivateEvidence } from '../helpers/public-mirror';
import { connectStdioServer, type StdioHarness } from './stdio-harness';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const PRIVATE = requiresPrivateEvidence({
  reason:
    'This built-server mission-move E2E derives its scratch project from the private live Reasonbook store.',
  paths: { liveDb: 'rbook/db/rbook.sqlite' },
});

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** A scratch project whose store is a COPY of the live one, plus two sprints to move between. */
function scratchProject(): { projectRoot: string; dbPath: string } {
  const projectRoot = mkTmp('rbook-m08-e2e-');
  const dbDir = path.join(projectRoot, 'rbook', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'rbook.sqlite');
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${PRIVATE.paths.liveDb}${suffix}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, `${dbPath}${suffix}`);
  }

  const db = new Database(dbPath);
  // The live schema carries the s69-m03 genesis columns as NOT NULL with a per-table
  // event_type CHECK, so a scratch row has to be a real row — stamping them by hand here is
  // what makes this a copy of the production shape rather than a convenient fiction.
  const genesis = (eventType: string, seq: number): unknown[] => [
    'cmos-mcp-pro',
    `E2E${String(seq).padStart(23, '0')}`,
    Date.now() + seq,
    900000 + seq,
    eventType,
    1,
  ];
  const insertSprint = db.prepare(
    `INSERT OR REPLACE INTO sprints
       (id, title, status, project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertSprint.run('sprint-e2e-open', 'E2E Open Sprint', 'Active', ...genesis('sprint_added', 1));
  insertSprint.run(
    'sprint-e2e-closed',
    'E2E Completed Sprint',
    'Completed',
    ...genesis('sprint_added', 2)
  );
  db.prepare(
    `INSERT OR REPLACE INTO missions
       (id, sprint_id, name, status, project_id, stable_event_id, occurred_at, origin_seq, event_type, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'e2e-m01',
    'sprint-e2e-closed',
    'Movable mission',
    'Deferred',
    ...genesis('mission_added', 3)
  );
  db.close();
  return { projectRoot, dbPath };
}

function row(
  dbPath: string,
  missionId: string
): { sprint_id: string | null; notes: string | null } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT sprint_id, notes FROM missions WHERE id = ?').get(missionId) as {
      sprint_id: string | null;
      notes: string | null;
    };
  } finally {
    db.close();
  }
}

PRIVATE.describe('rbook_mission(move) + parked_missions over stdio (s86-m08)', () => {
  let harness: StdioHarness | undefined;
  let projectRoot: string;
  let dbPath: string;

  beforeAll(async () => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY}. This suite drives the BUILT server; run ` +
          `\`npm run build\` first. It must not skip — a skipped transport test proves nothing.`
      );
    }
    if (!fs.existsSync(PRIVATE.paths.liveDb)) {
      throw new Error(
        `private live store not found at ${PRIVATE.paths.liveDb}; absence fails here unless the shared helper identified a structural public mirror.`
      );
    }
    ({ projectRoot, dbPath } = scratchProject());
    harness = await connectStdioServer({
      serverPath: DIST_ENTRY,
      cwd: projectRoot,
      env: {
        ...(process.env as Record<string, string>),
        RBOOK_PROJECT_ROOT: projectRoot,
        RBOOK_CONFIG_DIR: mkTmp('rbook-m08-e2e-cfg-'),
        RBOOK_CHECKPOINT_SYNC: 'off',
      },
      clientName: 'rbook-m08-move',
    });
  }, 180000);

  afterAll(async () => {
    if (harness) await harness.close();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('publishes the action and the parameter on the wire', async () => {
    const tools = (await harness!.client.listTools()) as {
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    };
    const mission = tools.tools.find((t) => t.name === 'rbook_mission')!;
    const schema = mission.inputSchema as {
      properties: Record<string, { enum?: string[]; description?: string }>;
    };

    expect(schema.properties.action?.enum).toContain('move');
    // Without this published property the boundary would REJECT the call below — the exact
    // way statusFilter/expiresAt/agentFeedback each shipped dead.
    expect(schema.properties.toSprintId).toBeDefined();
    // The 15-tool line: `move` is a new ACTION on an existing tool, never a 16th tool.
    expect(tools.tools).toHaveLength(15);
  }, 120000);

  it('executes a move end to end and writes the binding through the real dispatch path', async () => {
    const res = await harness!.callTool('rbook_mission', {
      action: 'move',
      missionId: 'e2e-m01',
      toSprintId: 'sprint-e2e-open',
      reason: 'executed under the open sprint',
      projectRoot,
    });

    expect(res.isError).not.toBe(true);
    const text = harness!.textOf(res);
    expect(text).toContain('sprint-e2e-closed → sprint-e2e-open');

    const after = row(dbPath, 'e2e-m01');
    expect(after.sprint_id).toBe('sprint-e2e-open');
    expect(after.notes ?? '').toContain('[Moved]');
  }, 120000);

  it('refuses a closed destination over the wire, with the reason an operator can act on', async () => {
    const res = await harness!.callTool('rbook_mission', {
      action: 'move',
      missionId: 'e2e-m01',
      toSprintId: 'sprint-e2e-closed',
      projectRoot,
    });

    const text = harness!.textOf(res);
    expect(text).toContain('carries no open work');
    expect(text).toContain('Suggestion:');
    // And the binding did not move.
    expect(row(dbPath, 'e2e-m01').sprint_id).toBe('sprint-e2e-open');
  }, 120000);

  it('upgrades the copied store on a sprint read and reports parked work', async () => {
    const res = await harness!.callOk('rbook_sprint', {
      action: 'show',
      sprintId: 'sprint-85',
      projectRoot,
    });

    const data = harness!.dataOf(res) as {
      totalMissions: number;
      completedMissions: number;
      parkedMissions: number;
    };
    // The number this mission exists for, produced by the SHIPPED server against a real store:
    // 9/5 = 56% becomes 5/5 = 100%, with the four dropped missions surfaced as parked.
    expect(data).toMatchObject({ totalMissions: 5, completedMissions: 5, parkedMissions: 4 });
    expect(harness!.textOf(res)).toContain('Parked (Deferred/Dropped): 4');

    // The migration really ran against the copy — not a fresh-fixture tautology.
    const db = new Database(dbPath, { readonly: true });
    try {
      const view = db
        .prepare(`SELECT sql FROM sqlite_master WHERE name='sprint_summary'`)
        .get() as { sql: string };
      expect(view.sql).toContain('parked_missions');
    } finally {
      db.close();
    }
  }, 120000);

  it('agrees across list, show and analytics — no two sprint read surfaces disagree', async () => {
    const list = harness!.dataOf(
      await harness!.callOk('rbook_sprint', { action: 'list', limit: 100, projectRoot })
    ) as { sprints: Array<{ id: string; totalMissions: number; parkedMissions: number }> };
    const s85List = list.sprints.find((s) => s.id === 'sprint-85')!;
    expect(s85List).toMatchObject({ totalMissions: 5, parkedMissions: 4 });

    // s106-m03: analytics rows come a page at a time, so read pages until sprint-85's row.
    type Analytics = {
      sprints: Array<{ sprintId: string; totalMissions: number; parkedMissions: number }>;
      nextPage: number | null;
    };
    let page: number | null = 1;
    let s85Analytics: Analytics['sprints'][number] | undefined;
    while (page !== null && !s85Analytics) {
      const analytics = harness!.dataOf(
        await harness!.callOk('rbook_sprint', {
          action: 'analytics',
          limit: 100,
          page,
          projectRoot,
        })
      ) as Analytics;
      s85Analytics = analytics.sprints.find((s) => s.sprintId === 'sprint-85');
      page = analytics.nextPage;
    }
    expect(s85Analytics).toMatchObject({ totalMissions: 5, parkedMissions: 4 });

    const retro = harness!.dataOf(
      await harness!.callOk('rbook_sprint', { action: 'retro', sprintId: 'sprint-85', projectRoot })
    ) as { kpis: { totalMissions: number; completionRate: number; parkedMissions: number } };
    // Retro computes from a raw missions SELECT, not the view — so this is the assertion that
    // catches the two code paths drifting apart.
    expect(retro.kpis).toMatchObject({ totalMissions: 5, completionRate: 100, parkedMissions: 4 });
  }, 120000);
});
