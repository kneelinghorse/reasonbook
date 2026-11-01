// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m02 — dates and reasons on every surface that reads next steps: a cmos/-layout store, onboard,
// ABOUTME: the session-start digest, the SQL lease beside the signals, and a close whose reason write fails.

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';
import { executeMissionProtocolTool } from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { LEGACY } from '../../../src/intelligence/legacy-compat';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { rbookNextSteps } from '../../../src/tools/rbook/rbook-next-steps';
import { rbookSession } from '../../../src/tools/rbook/rbook-session';
import { rbookSprint } from '../../../src/tools/rbook/rbook-sprint';
import { rbookSprintComplete } from '../../../src/tools/rbook/rbook-sprint-complete';
import { readLeaseAges, leaseState } from '../../../src/tools/rbook/next-step-lease';
import { utcDay } from '../../../src/tools/rbook/next-step-dates';
import { readDigestV2 } from '../../../src/tools/rbook/digest-v2-store';
import { renderDigestV2 } from '../../../src/tools/rbook/digest-v2';
import { computeSignals } from '../../../src/signals/read-signals';

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

let project: SeededRbookProject;
beforeEach(async () => {
  delete process.env.RBOOK_PROJECT_ROOT;
  delete process.env[`${LEGACY.envPrefix}PROJECT_ROOT`];
  project = await createSeededRbookProject({}, 'rbook-s108-m02-surfaces-');
});
afterEach(async () => {
  RbookDetector.resetInstance();
  await project.cleanup();
});
const root = () => project.projectRoot;
async function capture(content: string, checkAfter?: string): Promise<number> {
  const result = await rbookSession({
    action: 'capture',
    category: 'next-step',
    content,
    ...(checkAfter ? { checkAfter } : {}),
    projectRoot: root(),
  });
  if (!result.success) throw new Error(JSON.stringify(result.error));
  return (result.data as { nextStepId: number }).nextStepId;
}
async function sprint(id: string, status: string, endedDaysAgo?: number, dbPath = project.dbPath) {
  const added = await rbookSprint({ action: 'add', sprintId: id, title: id, projectRoot: root() });
  if (!added.success) throw new Error(JSON.stringify(added.error));
  const db = new Database(dbPath);
  try {
    db.prepare('UPDATE sprints SET status = ?, end_date = ? WHERE id = ?').run(
      status,
      endedDaysAgo === undefined ? null : at(-endedDaysAgo),
      id
    );
  } finally {
    db.close();
  }
}

it('works on a cmos/-layout store, with the explicit projectRoot and the environment unset', async () => {
  // The legacy layout: cmos/db/cmos.sqlite, as 21 projects on the operator's Mac still are.
  fs.renameSync(path.join(root(), 'rbook'), path.join(root(), LEGACY.recordDirectory));
  const legacyDb = path.join(root(), LEGACY.recordDirectory, 'db', LEGACY.databaseFile);
  fs.renameSync(path.join(root(), LEGACY.recordDirectory, 'db', 'rbook.sqlite'), legacyDb);
  RbookDetector.resetInstance();
  const day = utcDay(Date.now() + 25 * DAY);
  const dated = await capture('Legacy dated', day);
  const plain = await capture('Legacy plain');
  const list = await rbookNextSteps({ nextStepAction: 'list', projectRoot: root() });
  expect(list.data?.items?.find((item) => item.id === dated)).toMatchObject({ waitsUntil: day });
  const done = await rbookNextSteps({
    nextStepAction: 'complete',
    nextStepIds: [plain],
    reason: 'Done on the old layout',
    projectRoot: root(),
  });
  expect(done.data?.affected).toBe(1);
  await sprint('legacy-close', 'Active', undefined, legacyDb);
  const closed = await rbookSprintComplete({
    sprintId: 'legacy-close',
    summary: 'Legacy',
    projectRoot: root(),
  });
  expect(closed.success).toBe(true);
  const digest = renderDigestV2(await readDigestV2(root()), {
    projectRoot: root(),
    resolvedBy: 'cwd',
  });
  expect(digest.text).toContain('1 more next step waits until a date.');
  expect(fs.existsSync(path.join(root(), 'rbook'))).toBe(false);
});

it('leaves a waiting row out of onboard and the digest, which say how many wait', async () => {
  await rbookSession({ action: 'start', title: 'Onboard', projectRoot: root() });
  await capture('Waiting for the review', utcDay(Date.now() + 10 * DAY));
  await capture('Open now');
  await rbookSession({ action: 'complete', summary: 'Onboard', projectRoot: root() });
  const onboard = await executeMissionProtocolTool(
    'rbook_agent_onboard',
    { projectRoot: root() },
    {} as never
  );
  const items = (onboard.structuredContent as { data: { lastSession: { openItems: string[] } } })
    .data.lastSession.openItems;
  expect(items).toEqual(['Open now']);
  const digest = renderDigestV2(await readDigestV2(root()), {
    projectRoot: root(),
    resolvedBy: 'cwd',
  });
  expect(digest.text).toContain('Open now');
  expect(digest.text).not.toContain('Waiting for the review');
  expect(digest.text).toContain('1 more next step waits until a date.');
});

it('gives the SQL lease and the signals the same answer for dated, due, undated and unparseable rows', async () => {
  // A seeded generator, so a failure names a case that can be run again.
  let seed = 108;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let index = 0; index < 9; index++)
    await sprint(`close-${index}`, 'Completed', 2 + next() * 70);
  const ids: number[] = [];
  for (let index = 0; index < 40; index++) ids.push(await capture(`Row ${index}`));
  const db = new Database(project.dbPath);
  try {
    for (const id of ids) {
      const kind = Math.floor(next() * 5);
      const created = at(-(1 + next() * 90));
      // 0 undated, 1 carried at a past instant, 2 waiting on a day ahead, 3 due since a past day, 4 unparseable.
      const resolved = [
        null,
        at(-next() * 60),
        utcDay(Date.now() + (1 + next() * 100) * DAY),
        utcDay(Date.now() - (1 + next() * 60) * DAY),
        'not a time',
      ][kind];
      db.prepare(
        'UPDATE next_steps SET status = ?, created_at = ?, resolved_at = ? WHERE id = ?'
      ).run(kind === 0 ? 'pending' : 'carried', created, resolved, id);
    }
  } finally {
    db.close();
  }
  const opened = await RbookDatabaseClient.create({ dbPath: project.dbPath });
  const ages = readLeaseAges(opened.data!)!;
  opened.data!.close();
  const read = new Database(project.dbPath, { readonly: true });
  try {
    const anchors = new Map(
      (
        read
          .prepare('SELECT id, COALESCE(resolved_at, created_at) AS anchor FROM next_steps')
          .all() as Array<{
          id: number;
          anchor: string;
        }>
      ).map((row) => [row.id, row.anchor])
    );
    const known = ages.filter((age) => anchors.get(age.id) !== 'not a time');
    const due = known.filter(
      (age) => Date.parse(anchors.get(age.id)!) <= Date.now() && age.closesSurvived >= 3
    );
    // Not vacuous: every kind of row is present, and some are counted by the signal.
    const waiting = known.filter((age) => Date.parse(anchors.get(age.id)!) > Date.now());
    expect(ages).toHaveLength(40);
    expect(ages.length - known.length).toBeGreaterThan(0);
    expect(waiting.length).toBeGreaterThan(0);
    expect(due.length).toBeGreaterThan(0);
    expect(due.some((age) => /^\d{4}-\d{2}-\d{2}$/.test(anchors.get(age.id)!))).toBe(true);
    const report = computeSignals(read, { now: new Date(), storePath: project.dbPath });
    const lapsing = report.signals.find((signal) => signal.kind === 'next_steps_lapsing') as {
      count: number;
      lapseDue?: number;
      undated?: number;
    };
    expect(lapsing.count).toBe(due.length);
    expect(lapsing.lapseDue ?? 0).toBe(
      due.filter((age) => leaseState(age.closesSurvived, age.ageDays) === 'lapsing').length
    );
    expect(lapsing.undated ?? 0).toBe(ages.length - known.length);
    // A waiting row and an unparseable one are never warned, idle or lapsing by the SQL lease.
    for (const age of ages)
      if (!known.includes(age) || Date.parse(anchors.get(age.id)!) > Date.now())
        expect(leaseState(age.closesSurvived, age.ageDays)).toBe('ok');
  } finally {
    read.close();
  }
}, 60_000);

it('drops a lapsed row even when its reason cannot be kept, and says so in the receipt', async () => {
  const lapsing = await capture('Lapses without a reason');
  for (const [index, ago] of [20, 15, 10, 5].entries())
    await sprint(`old-${index}`, 'Completed', ago);
  const db = new Database(project.dbPath);
  try {
    db.prepare('UPDATE next_steps SET created_at = ? WHERE id = ?').run(at(-40), lapsing);
    db.exec(`CREATE TABLE next_step_reasons (stable_event_id TEXT PRIMARY KEY NOT NULL, reason TEXT NOT NULL,
      status TEXT NOT NULL, resolved_at TEXT NOT NULL, recorded_at TEXT NOT NULL)`);
    db.exec(`CREATE TRIGGER refuse_reasons BEFORE INSERT ON next_step_reasons
      BEGIN SELECT RAISE(ABORT, 'reasons refused for this test'); END`);
  } finally {
    db.close();
  }
  await sprint('closing', 'Active');
  const closed = await rbookSprintComplete({
    sprintId: 'closing',
    summary: 'Close',
    projectRoot: root(),
  });
  expect(closed.data?.lapsedDroppedIds).toEqual([lapsing]);
  expect(closed.warnings?.join(' ')).toContain(
    `A lease drop's reason was not kept for #${lapsing}`
  );
});
