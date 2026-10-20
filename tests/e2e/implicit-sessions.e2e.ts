// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m03 over stdio: real server processes share one store. Each writes under its own
// ABOUTME: implicit session, neither can close the other's, and a server-side close uploads nothing.

/**
 * Packs the existing build and drives its INSTALLED server (run `npm run build` first). Three scenarios:
 *
 *   1. ATTRIBUTION. Servers A and B run at the same time on one store. Each captures a decision and
 *      records one with no session named. Every row's author is that server's own implicit session,
 *      A cannot complete B's, and B's own complete leaves A's open.
 *   2. EXIT CLOSE. A server that captured and then loses its client closes its implicit session on
 *      the way out, with the deterministic summary.
 *   3. NO UPLOAD. A server whose environment WOULD upload (dashboard credentials pointed at a loopback
 *      double) reconciles a dead process's implicit session. That close must not reach the double.
 *      The positive control in the same live process, an explicit complete through the router, must
 *      reach it. The control is what keeps the zero from being vacuous. The exit path is
 *      deliberately not used for the zero: a fire-and-forget upload can die with its process, so
 *      "nothing arrived" after an exit proves nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { THIS_HOST_ID, processOwnerKey } from '../../src/tools/rbook/session-owner';
import { startDashboardDouble, type DashboardDouble } from '../helpers/suggestion-axes-external';
import { reidentifyRbookTestStore, seedRbookDb } from '../helpers/seedRbookDb';
import { connectStdioServer, dataOf, textOf, type StdioHarness } from './stdio-harness';
import { installPackedArtifact } from './packed-artifact';

const REPO_ROOT = path.resolve(__dirname, '../..');
let installedServer = '';
const REDIRECT_PRELOAD = path.join(__dirname, 'fixtures', 'dashboard-default-redirect.cjs');
const SPRINT = 'sprint-e2e-m03';

const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
});

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function buildProject(): { projectRoot: string; dbPath: string } {
  const projectRoot = mkTmp('rbook-e2e-m03-');
  const dbPath = seedRbookDb(projectRoot, { projectName: 's92-m03 e2e' });
  reidentifyRbookTestStore(projectRoot);
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO sprints (id, title, status, start_date) VALUES (?, 'E2E', 'Active', ?)`
    ).run(SPRINT, new Date().toISOString());
  } finally {
    db.close();
  }
  return { projectRoot, dbPath };
}

/** A literal whitelist: never spread process.env, whose credentials would leak into the fixture. */
function environment(projectRoot: string, dashboard?: DashboardDouble): Record<string, string> {
  const env: Record<string, string> = {
    HOME: mkTmp('rbook-e2e-m03-home-'),
    RBOOK_CONFIG_DIR: mkTmp('rbook-e2e-m03-config-'),
    RBOOK_PROJECT_ROOT: projectRoot,
    PATH: process.env.PATH ?? path.dirname(process.execPath),
    NODE_ENV: 'test',
  };
  if (dashboard) {
    env.RBOOK_DASHBOARD_URL = dashboard.origin;
    env.RBOOK_DASHBOARD_API_KEY = 'rbook_e2e_m03_key';
    env.NODE_OPTIONS = `--require=${REDIRECT_PRELOAD}`;
    env.RBOOK_TEST_DASHBOARD_REDIRECT_ORIGIN = dashboard.origin;
  }
  return env;
}

async function server(
  projectRoot: string,
  name: string,
  dashboard?: DashboardDouble
): Promise<StdioHarness> {
  const harness = await connectStdioServer({
    serverPath: installedServer,
    cwd: projectRoot,
    env: environment(projectRoot, dashboard),
    clientName: name,
  });
  cleanup.push(() => harness.close());
  return harness;
}

function readRows<T>(dbPath: string, sql: string, ...params: unknown[]): T[] {
  const db = new Database(dbPath);
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

describe('s92-m03 implicit sessions over stdio', () => {
  beforeAll(() => {
    installedServer = installPackedArtifact(REPO_ROOT, mkTmp).serverPath;
  }, 180_000);

  it("two live servers each write under their own implicit session, and cannot close each other's", async () => {
    const { projectRoot, dbPath } = buildProject();
    const a = await server(projectRoot, 'process-a');
    const b = await server(projectRoot, 'process-b');

    const sessions: Record<string, string> = {};
    for (const [name, harness] of [
      ['A', a],
      ['B', b],
    ] as const) {
      const captured = await harness.callOk('rbook_session', {
        action: 'capture',
        category: 'decision',
        content: `capture by ${name}`,
        projectRoot,
      });
      await harness.callOk('rbook_decisions', {
        action: 'record',
        content: `record by ${name}`,
        projectRoot,
      });
      sessions[name] = dataOf(captured).sessionId;
    }
    expect(sessions.A).not.toBe(sessions.B);

    expect(
      readRows<{ decision_text: string; author_session_id: string }>(
        dbPath,
        'SELECT decision_text, author_session_id FROM strategic_decisions ORDER BY id'
      )
    ).toEqual([
      { decision_text: 'capture by A', author_session_id: sessions.A },
      { decision_text: 'record by A', author_session_id: sessions.A },
      { decision_text: 'capture by B', author_session_id: sessions.B },
      { decision_text: 'record by B', author_session_id: sessions.B },
    ]);
    expect(
      readRows<{ id: string; implicit: number; owner_key: string }>(
        dbPath,
        'SELECT id, implicit, owner_key FROM sessions ORDER BY id'
      ).map((row) => [row.id, row.implicit, row.owner_key.startsWith(`pid:${THIS_HOST_ID}:`)])
    ).toEqual(
      [
        [sessions.A, 1, true],
        [sessions.B, 1, true],
      ].sort()
    );

    const refused = await a.callTool('rbook_session', {
      action: 'complete',
      sessionId: sessions.B,
      summary: 'A tries to close B',
      projectRoot,
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(sessions.B);

    await b.callOk('rbook_session', { action: 'complete', summary: 'B done', projectRoot });
    const statuses = Object.fromEntries(
      readRows<{ id: string; status: string }>(dbPath, 'SELECT id, status FROM sessions').map(
        (row) => [row.id, row.status]
      )
    );
    expect(statuses).toEqual({ [sessions.A]: 'active', [sessions.B]: 'completed' });
  });

  it('a server that loses its client closes its implicit session on the way out', async () => {
    const { projectRoot, dbPath } = buildProject();
    const c = await server(projectRoot, 'process-c');
    const captured = await c.callOk('rbook_session', {
      action: 'capture',
      category: 'next-step',
      content: 'carry this past the exit',
      projectRoot,
    });
    const sessionId: string = dataOf(captured).sessionId;
    // s100-m03 (#712): the row is there while the process still holds its session open.
    const stepRows = () =>
      readRows<{ id: number; content: string }>(
        dbPath,
        'SELECT id, content FROM next_steps WHERE session_id = ?',
        sessionId
      );
    expect(stepRows()).toEqual([
      { id: dataOf(captured).nextStepId, content: 'carry this past the exit' },
    ]);
    await c.close();

    const closed = await waitFor(
      () =>
        readRows<{ status: string }>(
          dbPath,
          'SELECT status FROM sessions WHERE id = ?',
          sessionId
        )[0]?.status === 'completed',
      15_000
    );
    expect(closed).toBe(true);
    const [row] = readRows<{ summary: string }>(
      dbPath,
      'SELECT summary FROM sessions WHERE id = ?',
      sessionId
    );
    expect(row.summary).toMatch(/^Closed automatically: its process ended\./);
    // The close at exit found that row and wrote no second one.
    expect(stepRows()).toEqual([
      { id: dataOf(captured).nextStepId, content: 'carry this past the exit' },
    ]);
  });

  it('a reconcile close uploads nothing; an explicit complete in the same live process does', async () => {
    const dashboard = await startDashboardDouble();
    cleanup.push(() => dashboard.close());
    const { projectRoot, dbPath } = buildProject();

    // An implicit session whose process is gone from this host.
    const deadPid = Number(
      spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout
    );
    const db = new Database(dbPath);
    try {
      db.prepare(
        `INSERT INTO sessions (id, type, title, started_at, status, captures, implicit, owner_key,
                               project_id, stable_event_id, occurred_at, origin_seq, event_type)
         VALUES ('PS-1999-01-01-001', 'custom', 'orphan', ?, 'active', '[]', 1, ?,
                 'e2e', 'e2e-orphan', 0, 1, 'session_started')`
      ).run(new Date().toISOString(), processOwnerKey(deadPid, 1));
    } finally {
      db.close();
    }

    const d = await server(projectRoot, 'process-d', dashboard);
    dashboard.clearRequests();
    const captured = await d.callOk('rbook_session', {
      action: 'capture',
      category: 'context',
      content: 'D arrives and reconciles',
      projectRoot,
    });
    expect(dataOf(captured).closedSessions).toEqual([
      expect.objectContaining({
        sessionId: 'PS-1999-01-01-001',
        reason: 'owner-exited',
        closed: true,
      }),
    ]);
    // Give a fire-and-forget upload, if one had been triggered, time to land. D is still alive.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(dashboard.requests.map((r) => `${r.method} ${r.url}`)).toEqual([]);

    // Positive control: an explicit complete through the router, same process, same environment.
    await d.callOk('rbook_session', { action: 'complete', summary: 'asked for', projectRoot });
    const uploaded = await waitFor(() => dashboard.requests.length > 0, 10_000);
    expect(uploaded).toBe(true);
  });
});
