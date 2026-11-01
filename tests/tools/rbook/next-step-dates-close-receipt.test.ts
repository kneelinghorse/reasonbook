// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m02 — an automatic close that a later call sets off says, in its receipt, which dated
// ABOUTME: captures it wrote undated because their day had come (the design's round 6's N4).

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { createSuccess } from '../../../src/tools/rbook/errors';
import { withClientAsync } from '../../../src/tools/rbook/client';
import { closedSessionLines } from '../../../src/tools/rbook/implicit-session-lifecycle';
import { rbookSessionCapture } from '../../../src/tools/rbook/rbook-session-capture';
import { utcDay } from '../../../src/tools/rbook/next-step-dates';
import {
  insertNewSession,
  processOwnerKey,
  setSessionOwnerForTesting,
  type SessionOwner,
} from '../../../src/tools/rbook/session-owner';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

const DAY = 86_400_000;
const live: SessionOwner = {
  key: processOwnerKey(process.pid, 1),
  kind: 'process',
  pid: process.pid,
};

/** A pid that was real and is now gone: a child that exited and was reaped. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(child.stdout.toString());
}

let projectRoot: string;
let dbPath: string;
beforeEach(() => {
  RbookDetector.resetInstance();
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s108-m02-receipt-'));
  dbPath = seedRbookDb(projectRoot, { projectName: 's108-m02 receipt' });
  reidentifyRbookTestStore(projectRoot);
});
afterEach(() => {
  setSessionOwnerForTesting(null);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

it('reports a dated capture written undated by the close that another call set off', async () => {
  // The session of a process that has exited, holding a dated capture whose row was never written
  // and whose day has since come.
  const passed = utcDay(Date.now() - 2 * DAY);
  const opened = await withClientAsync(
    async (client) => {
      const outcome = insertNewSession(client, {
        type: 'custom',
        title: 'exited owner',
        sprintId: null,
        agent: 'test',
        now: new Date(Date.now() - 3600_000).toISOString(),
        implicit: true,
        ownerKey: processOwnerKey(deadPid(), 7),
      });
      if (!outcome.ok) throw new Error(outcome.error.message);
      return createSuccess(outcome.sessionId);
    },
    { projectRoot }
  );
  const sessionId = opened.data!;
  const db = new Database(dbPath);
  try {
    db.prepare('UPDATE sessions SET captures = ? WHERE id = ?').run(
      JSON.stringify([
        {
          timestamp: new Date(Date.now() - 5 * DAY).toISOString(),
          category: 'next-step',
          content: 'Dated before its owner exited',
          checkAfter: passed,
        },
      ]),
      sessionId
    );
  } finally {
    db.close();
  }

  // Another process's first capture runs reconcile, which closes the exited owner's session.
  setSessionOwnerForTesting(live);
  const captured = await rbookSessionCapture({
    category: 'context',
    content: 'A later call',
    projectRoot,
  });
  expect(captured.success).toBe(true);
  const receipt = (captured.data!.closedSessions ?? []).find(
    (closed) => closed.sessionId === sessionId
  );
  expect(receipt).toMatchObject({ reason: 'owner-exited', closed: true });
  const written = new Database(dbPath, { readonly: true });
  try {
    const row = written
      .prepare('SELECT id, status, resolved_at FROM next_steps WHERE content = ?')
      .get('Dated before its owner exited') as { id: number; status: string; resolved_at: null };
    expect(row).toMatchObject({ status: 'pending', resolved_at: null });
    expect(receipt!.datesPassed).toEqual([{ id: row.id, checkAfter: passed }]);
    expect(closedSessionLines([receipt!])[0]).toContain(`#${row.id} (${passed})`);
  } finally {
    written.close();
  }
});
