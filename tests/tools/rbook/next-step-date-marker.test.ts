// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m02 — the bare YYYY-MM-DD spelling is what marks a date, so only the three paths that set
// ABOUTME: one may write it, every other next-step writer stamps a full instant, and nothing normalises it.

import { execFileSync } from 'child_process';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { rbookNextSteps } from '../../../src/tools/rbook/rbook-next-steps';
import { rbookSession } from '../../../src/tools/rbook/rbook-session';
import { rbookSprintComplete } from '../../../src/tools/rbook/rbook-sprint-complete';
import { rbookSprint } from '../../../src/tools/rbook/rbook-sprint';
import { utcDay } from '../../../src/tools/rbook/next-step-dates';
import { renameNumberedRow } from '../../../src/tools/rbook/record-renumber';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';

const REPO = path.resolve(__dirname, '../../..');
const DAY = 86_400_000;
const BARE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every statement in src that writes next_steps by name, by file: a new one fails here until it is
 * classified as a date path or a full-instant writer below. The 21 generic whole-table writers the
 * design's predicate finds copy stored values verbatim and are exempt by that predicate, not by name.
 * Where each is shown keeping a bare date: renumber below; the genesis rebuild in
 * next-step-dates-stores.test.ts; materialize, the fresh copy at join and settle in
 * next-step-shared-dates.test.ts. Import apply, spin-out copy and replay are checked by reading only
 * (decision #1785).
 */
const NAMED_WRITERS: Record<string, number> = {
  'src/tools/rbook/rbook-next-steps.ts': 5, // complete/drop, the two reasoned writes, reopen, both carries
  'src/tools/rbook/rbook-session-capture.ts': 1, // capture: a date path
  'src/tools/rbook/rbook-session-complete.ts': 2, // the rebuild (a date path) and nextSteps[] (undated)
  'src/tools/rbook/rbook-sprint-complete.ts': 1, // the lease drop
};
const GENERIC_WRITERS = 21;

function grep(pattern: string): string[] {
  const out = execFileSync('git', ['grep', '-nE', pattern, '--', 'src'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return out.trim().split('\n').filter(Boolean);
}

let project: SeededRbookProject;
let db: Database.Database;
beforeEach(async () => {
  project = await createSeededRbookProject({}, 'rbook-s108-m02-marker-');
  db = new Database(project.dbPath);
});
afterEach(async () => {
  db.close();
  await project.cleanup();
});

it('finds every named next-step writer where the classification expects it, and the generic writers by the predicate', () => {
  const lines = grep('(INSERT INTO next_steps|UPDATE next_steps SET)');
  const byFile: Record<string, number> = {};
  for (const line of lines) {
    const file = line.slice(0, line.indexOf(':'));
    byFile[file] = (byFile[file] ?? 0) + 1;
  }
  expect(byFile).toEqual(NAMED_WRITERS);
  expect(
    grep('(INSERT( OR [A-Z]+)? INTO|UPDATE) "?\\$\\{([a-zA-Z]+\\.)?(table|entity|tmpTable)\\}')
  ).toHaveLength(GENERIC_WRITERS);
});

it('keeps a bare date only where a date path wrote it, through every other writer and a full open', async () => {
  const day = utcDay(Date.now() + 30 * DAY);
  const later = utcDay(Date.now() + 50 * DAY);
  const capture = async (content: string, checkAfter?: string) =>
    (
      (
        await rbookSession({
          action: 'capture',
          category: 'next-step',
          content,
          ...(checkAfter ? { checkAfter } : {}),
          projectRoot: project.projectRoot,
        })
      ).data as { nextStepId: number }
    ).nextStepId;
  const steps = (args: Record<string, unknown>) =>
    rbookNextSteps({ projectRoot: project.projectRoot, ...args } as Parameters<
      typeof rbookNextSteps
    >[0]);

  const dated = await capture('Dated at capture', day);
  const carried = await capture('Dated by a carry');
  await steps({ nextStepAction: 'carry', nextStepIds: [carried], checkAfter: later });
  const others = [
    await capture('Completed'),
    await capture('Dropped'),
    await capture('Reopened'),
    await capture('Carried'),
  ];
  await steps({ nextStepAction: 'complete', nextStepIds: [others[0]], reason: 'done' });
  await steps({ nextStepAction: 'drop', nextStepIds: [others[1]] });
  await steps({ nextStepAction: 'complete', nextStepIds: [others[2]] });
  await steps({ nextStepAction: 'reopen', nextStepIds: [others[2]] });
  await steps({ nextStepAction: 'carry', nextStepIds: [others[3]] });
  await steps({ nextStepAction: 'carry' });
  await rbookSession({ action: 'start', title: 'Marker', projectRoot: project.projectRoot });
  await rbookSession({
    action: 'complete',
    summary: 'Marker',
    nextSteps: ['From nextSteps'],
    projectRoot: project.projectRoot,
  });
  // A lapsing row, so the close's drop writes too.
  const lapsing = await capture('Lapses');
  db.prepare('UPDATE next_steps SET created_at = ? WHERE id = ?').run(
    new Date(Date.now() - 40 * DAY).toISOString(),
    lapsing
  );
  // Sprints made by the tool carry the genesis columns; their status and close time are then set.
  for (let index = 0; index < 4; index++) {
    await rbookSprint({
      action: 'add',
      sprintId: `old-${index}`,
      title: `Old ${index}`,
      projectRoot: project.projectRoot,
    });
    db.prepare("UPDATE sprints SET status = 'Completed', end_date = ? WHERE id = ?").run(
      new Date(Date.now() - (20 - index * 4) * DAY).toISOString(),
      `old-${index}`
    );
  }
  await rbookSprint({
    action: 'add',
    sprintId: 'closing',
    title: 'Closing',
    projectRoot: project.projectRoot,
  });
  const closed = await rbookSprintComplete({
    sprintId: 'closing',
    summary: 'Marker close',
    projectRoot: project.projectRoot,
  });
  expect(closed.data?.lapsedDroppedIds).toEqual([lapsing]);

  // A renumber deletes the row and inserts it again under a new id: the date is copied as written.
  const stable = (
    db.prepare('SELECT stable_event_id AS s FROM next_steps WHERE id = ?').get(carried) as {
      s: string;
    }
  ).s;
  const opened = await RbookDatabaseClient.create({ dbPath: project.dbPath });
  try {
    renameNumberedRow(opened.data!, 'next_steps', stable, carried, carried + 500);
  } finally {
    opened.data!.close();
  }
  const renumbered = carried + 500;

  // A full open through dispatch runs the point-of-use migrations, which must not touch the spelling.
  await executeMissionProtocolTool(
    'rbook_review',
    { projectRoot: project.projectRoot },
    await buildMissionProtocolContext()
  );

  const stamps = db
    .prepare('SELECT id, resolved_at FROM next_steps WHERE resolved_at IS NOT NULL')
    .all() as Array<{
    id: number;
    resolved_at: string;
  }>;
  const bare = stamps.filter((stamp) => BARE.test(stamp.resolved_at));
  expect(bare).toEqual([
    { id: dated, resolved_at: day },
    { id: renumbered, resolved_at: later },
  ]);
  for (const stamp of stamps.filter((entry) => !BARE.test(entry.resolved_at)))
    expect(stamp.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
}, 60_000);
