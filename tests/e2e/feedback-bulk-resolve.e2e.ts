// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m07 — rbook_feedback resolves many rows in one call, all or none, over real MCP stdio against the
// ABOUTME: BUILT dist/, where nothing between the caller and the handler checks feedbackIds.

/**
 * The design's dispatch boundary: the MCP client checks a tool's output and never its arguments,
 * and the server hands the router its arguments unparsed, so only the handler can refuse a bad
 * feedbackIds, and only a call through this transport shows that it does. An unknown id must
 * refuse the whole call, so a typo never leaves the other rows half-resolved.
 *
 * ISOLATION: a literal environment whitelist, as mission-target-status.e2e.ts uses. RBOOK_PROJECT_ROOT
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

describe('s97-m07 bulk resolve over built stdio', () => {
  let harness: StdioHarness | undefined;
  let projectRoot: string;
  let ids: number[];

  /** The rows as the store holds them, read beside the server rather than through it. */
  function statuses(): string[] {
    const db = new Database(path.join(projectRoot, 'rbook', 'db', 'rbook.sqlite'), {
      readonly: true,
    });
    try {
      return (
        db.prepare('SELECT status FROM agent_feedback ORDER BY id').all() as Array<{
          status: string;
        }>
      ).map((row) => row.status);
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
    projectRoot = mkTmp('rbook-s97m07-bulk-');
    harness = await connectStdioServer({
      serverPath: DIST_ENTRY,
      cwd: projectRoot,
      env: {
        HOME: mkTmp('rbook-s97m07-home-'),
        RBOOK_CONFIG_DIR: mkTmp('rbook-s97m07-config-'),
        RBOOK_PROJECT_ROOT: mkTmp('rbook-s97m07-envroot-'),
        RBOOK_CHECKPOINT_SYNC: 'off',
        PATH: process.env.PATH ?? path.dirname(process.execPath),
        NODE_ENV: 'test',
      },
      clientName: 's97-m07-bulk-resolve-e2e',
    });
    await harness.callOk('rbook_project', {
      action: 'init',
      projectRoot,
      projectName: 'Bulk resolve',
    });
    for (const agentFeedback of [
      'cmos_mission(action="status") returned an 81KB payload past the token cap.',
      'cmos_review build-freshness warning never clears.',
      'The project tests were flaky.',
    ])
      await harness.callOk('rbook_agent_onboard', { agentFeedback, projectRoot });
    const db = new Database(path.join(projectRoot, 'rbook', 'db', 'rbook.sqlite'), {
      readonly: true,
    });
    try {
      ids = (
        db.prepare('SELECT id FROM agent_feedback ORDER BY id').all() as Array<{ id: number }>
      ).map((row) => row.id);
    } finally {
      db.close();
    }
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.close();
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('counts the rows by kind over the wire', async () => {
    const res = await harness!.callOk('rbook_feedback', { action: 'list', projectRoot });
    expect(res.structuredContent?.data).toMatchObject({
      countsByKind: { payload: 1, ceremony: 1, unclassified: 1 },
    });
  }, 60_000);

  it('refuses a feedbackIds that is not a list, and resolves nothing', async () => {
    const res = await harness!.callTool('rbook_feedback', {
      action: 'resolve',
      feedbackIds: 'all',
      projectRoot,
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error).toMatchObject({ code: 'INVALID_PARAMETER' });
    expect(statuses()).toEqual(['open', 'open', 'open']);
  }, 60_000);

  it('refuses the whole call over an unknown id, naming it, and resolves nothing', async () => {
    const res = await harness!.callTool('rbook_feedback', {
      action: 'resolve',
      feedbackIds: [ids[0], 99999],
      projectRoot,
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error?.code).toBe('FEEDBACK_NOT_FOUND');
    expect(res.structuredContent?.error?.message).toContain('99999');
    expect(statuses()).toEqual(['open', 'open', 'open']);
  }, 60_000);

  it('resolves the listed rows in one call and leaves the rest open', async () => {
    const res = await harness!.callOk('rbook_feedback', {
      action: 'resolve',
      feedbackIds: [ids[0], ids[1]],
      resolutionNote: 'Fixed.',
      projectRoot,
    });
    expect(res.structuredContent?.data).toMatchObject({
      resolved: [
        { feedbackId: ids[0], previousStatus: 'open', currentStatus: 'resolved' },
        { feedbackId: ids[1], previousStatus: 'open', currentStatus: 'resolved' },
      ],
    });
    expect(statuses()).toEqual(['resolved', 'resolved', 'open']);
  }, 60_000);
});
