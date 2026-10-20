// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s100-m02 — start and unblock refuse a targetStatus outside In Progress and Current, over real MCP
// ABOUTME: stdio against the BUILT dist/, where nothing between the caller and the handler checks the enum.

/**
 * The s97 review's finding 14. `targetStatus` is published with two values, In Progress and Current,
 * but nothing on the way to the handler holds a caller to them: the MCP client checks a tool's output
 * and never its arguments, and the server forwards the arguments to the router unparsed. So `start`
 * with `targetStatus: "Dropped"` dropped a Queued mission and answered that it had started, and
 * `unblock`, from Blocked, which may also move to Dropped or Deferred, could do the same. Only the
 * handler can refuse, and only a call through this transport shows that it does.
 *
 * ISOLATION: a literal environment whitelist, as resolution-safety.e2e.ts uses. RBOOK_PROJECT_ROOT
 * points at an empty directory so the server cannot read the repository's .env, and checkpoint sync
 * is off.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { connectStdioServer, type StdioHarness } from './stdio-harness';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');

const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

describe('s100-m02 targetStatus over built stdio', () => {
  let harness: StdioHarness | undefined;
  let projectRoot: string;

  /** The mission as the store holds it, read beside the server rather than through it. */
  function mission(id: string): { status: string; started_at: string | null } {
    const db = new Database(path.join(projectRoot, 'rbook', 'db', 'rbook.sqlite'), {
      readonly: true,
    });
    try {
      return db.prepare('SELECT status, started_at FROM missions WHERE id = ?').get(id) as {
        status: string;
        started_at: string | null;
      };
    } finally {
      db.close();
    }
  }

  beforeAll(async () => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY}. This suite drives the BUILT server; run ` +
          '`npm run build` first. It must never skip when the artifact is absent.'
      );
    }
    projectRoot = mkTmp('rbook-s100m02-target-');
    harness = await connectStdioServer({
      serverPath: DIST_ENTRY,
      cwd: projectRoot,
      env: {
        HOME: mkTmp('rbook-s100m02-home-'),
        RBOOK_CONFIG_DIR: mkTmp('rbook-s100m02-config-'),
        RBOOK_PROJECT_ROOT: mkTmp('rbook-s100m02-envroot-'),
        RBOOK_CHECKPOINT_SYNC: 'off',
        PATH: process.env.PATH ?? path.dirname(process.execPath),
        NODE_ENV: 'test',
      },
      clientName: 's100-m02-target-status-e2e',
    });
    await harness.callOk('rbook_project', {
      action: 'init',
      projectRoot,
      projectName: 'Target status',
    });
    await harness.callOk('rbook_sprint', {
      action: 'add',
      sprintId: 'sprint-1',
      title: 'Target status',
      projectRoot,
    });
    await harness.callOk('rbook_mission', {
      action: 'add',
      missionId: 'ts-m01',
      sprintId: 'sprint-1',
      name: 'A queued mission',
      projectRoot,
    });
    await harness.callOk('rbook_mission', {
      action: 'add',
      missionId: 'ts-m02',
      sprintId: 'sprint-1',
      name: 'A blocked mission',
      status: 'Blocked',
      projectRoot,
    });
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('start refuses Dropped, names the two values it takes, and leaves the mission Queued', async () => {
    const res = await harness!.callTool('rbook_mission_transition', {
      action: 'start',
      missionId: 'ts-m01',
      targetStatus: 'Dropped',
      projectRoot,
    });

    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({
      code: 'INVALID_PARAMETER',
      field: 'targetStatus',
      validValues: ['In Progress', 'Current'],
    });
    // Before the fix the mission was Dropped, stamped as started.
    expect(mission('ts-m01')).toEqual({ status: 'Queued', started_at: null });
  }, 60_000);

  it.each(['Dropped', 'Deferred'])(
    'unblock refuses %s and leaves the mission Blocked',
    async (targetStatus) => {
      const res = await harness!.callTool('rbook_mission_transition', {
        action: 'unblock',
        missionId: 'ts-m02',
        resolution: 'not resolved',
        targetStatus,
        projectRoot,
      });

      expect(res.isError).toBe(true);
      expect(res.structuredContent?.error).toMatchObject({
        code: 'INVALID_PARAMETER',
        field: 'targetStatus',
        validValues: ['In Progress', 'Current'],
      });
      expect(mission('ts-m02').status).toBe('Blocked');
    },
    60_000
  );

  it('still takes Current over the wire, for both actions', async () => {
    // The refusal is about the value, not the parameter: the published value reaches the handler.
    await harness!.callOk('rbook_mission_transition', {
      action: 'start',
      missionId: 'ts-m01',
      targetStatus: 'Current',
      projectRoot,
    });
    expect(mission('ts-m01')).toEqual({ status: 'Current', started_at: null });

    await harness!.callOk('rbook_mission_transition', {
      action: 'unblock',
      missionId: 'ts-m02',
      resolution: 'resolved',
      targetStatus: 'Current',
      projectRoot,
    });
    expect(mission('ts-m02').status).toBe('Current');
  }, 60_000);
});
