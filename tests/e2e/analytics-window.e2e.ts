// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m05 — rbook_sprint(analytics, limit=N) over real MCP stdio against the BUILT dist/,
// ABOUTME: on a tmpdir COPY of the live rbook.sqlite. Proves `limit` survives the dispatch boundary.

/**
 * Sprint 86 m05 — the analytics window, proven through the transport it actually ships over.
 *
 * WHY THIS EXISTS SEPARATELY FROM tests/tools/rbook/analytics-window-real-store.test.ts.
 * The sprint's load-bearing constraint has TWO halves and neither substitutes for the other:
 *   - a REAL-STORE positive fire proves the SQL matches a migrated store's actual columns;
 *   - a run over stdio AGAINST THE BUILT dist/ proves the parameter survives the MCP dispatch
 *     boundary and reaches the handler at all.
 * Handler-only testing is precisely what let `statusFilter`, `expiresAt` and `agentFeedback`
 * each ship declared-but-never-forwarded. `limit` is forwarded to the analytics branch by the
 * router; a handler test cannot see a router that drops it. This file does BOTH halves at once:
 * the built server, over stdio, against a copy of the real store.
 *
 * WHY IT LIVES IN tests/e2e/ AND NOT THE DEFAULT SUITE — stated rather than left to be
 * rediscovered. The `npm test` CI job (quality-tooling.yml) runs npm ci → lint → format → test
 * with NO build step, so dist/ does not exist there; a dist-dependent test in the default suite
 * would either fail CI or, worse, skip itself green. The first-run-e2e job DOES run
 * `npm run build` before `npm run test:e2e-firstrun`, and jest.e2e.config.js picks up
 * `tests/e2e/*.e2e.ts`. So this is the only place in the repo where "against the rebuilt dist/"
 * is a statement that can be true. Locally: `npm run build && npm run test:e2e-firstrun`.
 *
 * NO SILENT FAIL-OPEN (agents.md Process Hardening #4). A missing dist/ or live store FAILS in
 * the private tree. Only a structurally identified public mirror skips, and the shared helper
 * prints the evidence and reason it scoped out.
 *
 * NEVER AGAINST THE LIVE FILE. The server is pointed at an `mkdtempSync` copy.
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
    'This built-server analytics E2E derives its scratch project from the private live Reasonbook store.',
  paths: { liveDb: 'rbook/db/rbook.sqlite' },
});

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Copy the live store into a temp project root. The live file is never opened for writing. */
function copyLiveStore(): string {
  const projectRoot = mkTmp('rbook-m05-stdio-');
  const dbDir = path.join(projectRoot, 'rbook', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${PRIVATE.paths.liveDb}${suffix}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dbDir, `rbook.sqlite${suffix}`));
  }
  return projectRoot;
}

/** Independent JS oracle for the shipped SQL contract; BigInt avoids SQLite INTEGER limits. */
function orderSprintIds(ids: string[], direction: 'ASC' | 'DESC'): string[] {
  const directionFactor = direction === 'ASC' ? 1 : -1;
  const canonical = /^sprint-(\d+)$/;

  return [...ids].sort((left, right) => {
    const leftMatch = canonical.exec(left);
    const rightMatch = canonical.exec(right);
    if (leftMatch && !rightMatch) return -1;
    if (!leftMatch && rightMatch) return 1;
    if (leftMatch && rightMatch) {
      const leftNumber = BigInt(leftMatch[1]);
      const rightNumber = BigInt(rightMatch[1]);
      if (leftNumber !== rightNumber) {
        return (leftNumber < rightNumber ? -1 : 1) * directionFactor;
      }
    }
    return Buffer.compare(Buffer.from(left), Buffer.from(right)) * directionFactor;
  });
}

PRIVATE.describe('analytics window over stdio against the built dist (s86-m05)', () => {
  let harness: StdioHarness;
  let projectRoot: string;
  let newestFive: string[];
  let oldestFive: string[];

  beforeAll(async () => {
    // Premise checks first, as assertions rather than guards — see NO SILENT FAIL-OPEN above.
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY}. This suite drives the BUILT server; ` +
          `run \`npm run build\` first. It must not skip — a skipped transport test proves nothing.`
      );
    }
    if (!fs.existsSync(PRIVATE.paths.liveDb)) {
      throw new Error(
        `private live store not found at ${PRIVATE.paths.liveDb}; absence fails here unless the shared helper identified a structural public mirror.`
      );
    }

    projectRoot = copyLiveStore();

    // Ground both ends of the numeric ordering in the copy rather than hardcoded IDs, so the
    // assertion keeps meaning as sprints accumulate and proves the selected window's direction.
    const db = new Database(path.join(projectRoot, 'rbook', 'db', 'rbook.sqlite'), {
      readonly: true,
    });
    const eligibleIds = db
      .prepare(`SELECT sprint_id FROM sprint_summary WHERE status IN ('Completed','Active')`)
      .all()
      .map((r) => (r as { sprint_id: string }).sprint_id);
    newestFive = orderSprintIds(eligibleIds, 'DESC').slice(0, 5);
    oldestFive = orderSprintIds(eligibleIds, 'ASC').slice(0, 5);
    db.close();

    harness = await connectStdioServer({
      serverPath: DIST_ENTRY,
      cwd: projectRoot,
      env: {
        ...(process.env as Record<string, string>),
        RBOOK_PROJECT_ROOT: projectRoot,
        // Isolate the per-user registry so driving the built server never touches
        // ~/.config/rbook/project-graph.sqlite.
        RBOOK_CONFIG_DIR: mkTmp('rbook-m05-cfg-'),
      },
      clientName: 'rbook-m05-analytics-window',
    });
  }, 120000);

  afterAll(async () => {
    if (harness) await harness.close();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the NEWEST five sprints for limit=5, not the oldest five', async () => {
    const res = await harness.callOk('rbook_sprint', {
      action: 'analytics',
      limit: 5,
      projectRoot,
    });
    const data = harness.dataOf(res) as {
      sprints: Array<{ sprintId: string }>;
      window: { requestedLimit: number | null; oldestSprintId: string; newestSprintId: string };
    };

    const returned = data.sprints.map((s) => s.sprintId);

    // `limit` reached the handler at all — the dispatch-boundary half of the claim.
    expect(returned).toHaveLength(5);

    // …and it bounded the window at the NEWEST end, handed back oldest-first.
    expect(returned).toEqual([...newestFive].reverse());

    // The independent oldest window, asserted as DISJOINTNESS rather than by naming sprint IDs.
    // A hardcoded ID would become a time-bomb as soon as another sprint opens; the durable claim
    // is that a sufficiently long history's newest and oldest windows share no members.
    expect(newestFive).not.toEqual(oldestFive);
    for (const oldId of oldestFive) expect(returned).not.toContain(oldId);

    // The answer names the window it describes.
    expect(data.window.requestedLimit).toBe(5);
    expect(data.window.newestSprintId).toBe(newestFive[0]);
  }, 60000);

  it('renders the window in the answer text, not just the structured payload', async () => {
    // A field only present in structuredContent is invisible to an agent reading the answer —
    // the same fail-quiet shape s86-m02 fixed elsewhere in this sprint.
    const res = await harness.callOk('rbook_sprint', {
      action: 'analytics',
      limit: 5,
      projectRoot,
    });
    const text = harness.textOf(res);
    expect(text).toMatch(/\*\*Window\*\*/);
    expect(text).toContain(newestFive[0]);
    expect(text).toContain([...newestFive].reverse()[0]);
    expect(text).toMatch(/oldest → newest/);
  }, 60000);

  it('leaves the unlimited call unbounded', async () => {
    type Analytics = {
      sprints: Array<{ sprintId: string }>;
      window: { requestedLimit: number | null; sprintCount: number; oldestSprintId: string | null };
      nextPage: number | null;
    };
    const res = await harness.callOk('rbook_sprint', { action: 'analytics', projectRoot });
    const data = harness.dataOf(res) as Analytics;
    expect(data.window.requestedLimit).toBeNull();
    expect(data.window.sprintCount).toBeGreaterThan(5);
    // Unbounded is still oldest-first, so the trend semantics are the same in both modes.
    expect(data.window.oldestSprintId).toBe(oldestFive[0]);
    // s106-m03: the rows come a page at a time counted from the newest, oldest-first within a
    // page, so the last page begins with the oldest sprint.
    let last = data;
    while (last.nextPage !== null)
      last = harness.dataOf(
        await harness.callOk('rbook_sprint', {
          action: 'analytics',
          page: last.nextPage,
          projectRoot,
        })
      ) as Analytics;
    expect(last.sprints[0].sprintId).toBe(oldestFive[0]);
  }, 60000);
});
