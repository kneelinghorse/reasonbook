// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m02 — a dated next step waits through closes, is due from its day and lapses on schedule;
// ABOUTME: a reason stays with the resolution it explains. Older releases' own statements run beside them.

import Database from 'better-sqlite3';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';
import { rbookNextSteps, formatNextStepsForLLM } from '../../../src/tools/rbook/rbook-next-steps';
import { rbookSession } from '../../../src/tools/rbook/rbook-session';
import {
  formatSprintCompleteForLLM,
  rbookSprintComplete,
} from '../../../src/tools/rbook/rbook-sprint-complete';
import { renameNumberedRow } from '../../../src/tools/rbook/record-renumber';
import { rbookSprint } from '../../../src/tools/rbook/rbook-sprint';
import { getProjectId } from '../../../src/tools/rbook/project-id';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { utcDay } from '../../../src/tools/rbook/next-step-dates';
import { leaseState } from '../../../src/tools/rbook/next-step-lease';
import { digestWork } from '../../../src/tools/rbook/digest-work';
import { computeSignals } from '../../../src/signals/read-signals';

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const dayAt = (days: number) => utcDay(Date.now() + days * DAY);

/**
 * 4.9.0's own statements, copied from v4.9.0's source (unchanged from v4.5.1, the design's round 2),
 * so the tests show what an older runtime on the same store does without fetching it.
 */
// src/tools/rbook/next-step-lease.ts:54-61 at v4.9.0
const V490_CLOSES_SURVIVED = `(SELECT COUNT(*) FROM sprints s
    WHERE s.status = 'Completed'
      AND s.end_date IS NOT NULL AND s.end_date <> ''
      AND julianday(s.end_date) <= julianday('now')
      AND julianday(s.end_date) > julianday(COALESCE(n.resolved_at, n.created_at)))`;
const V490_AGE_DAYS = `(julianday('now') - julianday(COALESCE(n.resolved_at, n.created_at)))`;
const V490 = {
  closesSurvived: V490_CLOSES_SURVIVED,
  ageDays: V490_AGE_DAYS,
  // src/tools/rbook/rbook-sprint-complete.ts:1345-1350 at v4.9.0, the close's lease survey, with
  // LEASED_STATUS_SQL inlined ("n.status IN ('pending','carried')", next-step-lease.ts:64).
  survey: `SELECT n.id, n.content, n.sprint_id, n.mission_id, n.status,
            ${V490_CLOSES_SURVIVED} AS closes_survived,
            ${V490_AGE_DAYS} AS age_days
       FROM next_steps n
      WHERE n.status IN ('pending','carried')
      ORDER BY n.id ASC`,
  // src/tools/rbook/rbook-next-steps.ts:351 at v4.9.0, carry by id
  carry: `UPDATE next_steps SET status = 'carried', resolved_at = ?, carried_to_sprint = ? WHERE id = ? AND status IN ('pending','carried')`,
  // src/tools/rbook/rbook-next-steps.ts:268 at v4.9.0
  reopen: `UPDATE next_steps SET status = 'pending', resolved_at = CASE WHEN status = 'carried' THEN resolved_at ELSE NULL END, carried_to_sprint = NULL WHERE id = ? AND status IN ('completed','dropped','carried')`,
};

let project: SeededRbookProject;
let db: Database.Database;
beforeEach(async () => {
  project = await createSeededRbookProject({}, 'rbook-s108-m02-');
  db = new Database(project.dbPath);
});
afterEach(async () => {
  db.close();
  await project.cleanup();
});

const root = () => project.projectRoot;
async function capture(content: string, checkAfter?: string) {
  const result = await rbookSession({
    action: 'capture',
    category: 'next-step',
    content,
    ...(checkAfter === undefined ? {} : { checkAfter }),
    projectRoot: root(),
  });
  if (!result.success) throw new Error(JSON.stringify(result.error));
  return (result.data as { nextStepId: number }).nextStepId;
}
const steps = (args: Record<string, unknown>) =>
  rbookNextSteps({ projectRoot: root(), ...args } as Parameters<typeof rbookNextSteps>[0]);
const row = (id: number) =>
  db
    .prepare('SELECT status, resolved_at, carried_to_sprint FROM next_steps WHERE id = ?')
    .get(id) as {
    status: string;
    resolved_at: string | null;
    carried_to_sprint: string | null;
  };
async function show(id: number) {
  const result = await steps({ nextStepAction: 'show', nextStepIds: [id] });
  return { item: result.data!.items![0], text: formatNextStepsForLLM(result) };
}
/** A sprint made by the tool, so it carries the genesis columns, then given its status and close time. */
async function sprint(id: string, status = 'Active', endedDaysAgo?: number) {
  const added = await rbookSprint({ action: 'add', sprintId: id, title: id, projectRoot: root() });
  if (!added.success) throw new Error(JSON.stringify(added.error));
  db.prepare('UPDATE sprints SET status = ?, end_date = ? WHERE id = ?').run(
    status,
    endedDaysAgo === undefined ? null : at(-endedDaysAgo),
    id
  );
}
async function close(id: string) {
  const result = await rbookSprintComplete({
    sprintId: id,
    summary: `Close ${id}`,
    projectRoot: root(),
  });
  if (!result.success) throw new Error(JSON.stringify(result.error));
  return { data: result.data!, text: formatSprintCompleteForLLM(result) };
}
async function client<T>(use: (c: RbookDatabaseClient) => T): Promise<T> {
  const opened = await RbookDatabaseClient.create({ dbPath: project.dbPath });
  try {
    return use(opened.data!);
  } finally {
    opened.data!.close();
  }
}

describe('a dated next step', () => {
  it('waits through four closes over fourteen days, is due from its day, and then lapses on schedule', async () => {
    const day = dayAt(30);
    const dated = await capture('Check the listing after it has run for a month', day);
    const control = await capture('An undated row the closes drop');
    // Both made 40 days ago, so the undated one is old enough for the floor once it lapses.
    db.prepare('UPDATE next_steps SET created_at = ?').run(at(-40));
    expect(row(dated)).toEqual({ status: 'carried', resolved_at: day, carried_to_sprint: null });

    // Four closes before the day, 20, 15, 10 and 5 days ago, then a fifth now.
    for (const [index, ago] of [20, 15, 10, 5].entries())
      await sprint(`old-${index}`, 'Completed', ago);
    await sprint('closing');
    const closed = await close('closing');
    expect(closed.data.lapsedDroppedIds).toEqual([control]);
    expect(row(dated).status).toBe('carried');
    expect(row(dated).resolved_at).toBe(day);
    expect(closed.text).toContain(
      `Waiting until a date (left out of the open work; no close drops them before it): #${dated} until ${day}`
    );
    const prompt = closed.text.slice(closed.text.indexOf('Closing sprint with mission provenance'));
    expect(prompt).not.toContain(`#${dated}`);
    // The row this close dropped is not put to the closer again.
    expect(prompt).not.toContain(`#${control}`);
    expect((await show(dated)).text).toContain(`#${dated} [carried] {waits until ${day}}`);
    expect((await show(dated)).item).toMatchObject({
      waitsUntil: day,
      closesSurvived: 0,
      lease: 'ok',
    });

    // The day has come: plant it 16 days back, as the clock would have it. Four closes are after it
    // (15, 10 and 5 days ago, and the one just made), and it is past the 14-day floor.
    const past = dayAt(-16);
    db.prepare('UPDATE next_steps SET resolved_at = ? WHERE id = ?').run(past, dated);
    expect((await show(dated)).item).toMatchObject({
      dueSince: past,
      closesSurvived: 4,
      lease: 'lapsing',
    });
    expect((await show(dated)).text).toContain(`{due since ${past}} {closes survived 4, lapsing}`);
    const work = await client((c) => digestWork(c, 'builder', getProjectId(c), null));
    expect(work.nextSteps!.rows[0].text).toBe(
      `[due since ${past}] [lease lapsing] Check the listing after it has run for a month`
    );

    // From the day on its lease runs as any row's, so the next close drops it, with the reason.
    await sprint('next');
    const lapsed = await close('next');
    expect(lapsed.data.lapsedDroppedIds).toEqual([dated]);
    expect((await show(dated)).item).toMatchObject({
      status: 'dropped',
      reason: 'lease lapsed at next close',
    });
  });

  it('keeps its date through a 4.10.0 carry, by id or broad, and moves it with a new checkAfter', async () => {
    const day = dayAt(40);
    const id = await capture('Wait for the review', day);
    expect((await steps({ nextStepAction: 'carry', nextStepIds: [id] })).data?.affected).toBe(1);
    expect(row(id).resolved_at).toBe(day);
    expect((await steps({ nextStepAction: 'carry' })).data?.affected).toBe(1);
    expect(row(id).resolved_at).toBe(day);
    const later = dayAt(60);
    const moved = await steps({ nextStepAction: 'carry', nextStepIds: [id], checkAfter: later });
    expect(moved.data?.message).toContain(`waiting until ${later}`);
    expect(row(id)).toEqual({ status: 'carried', resolved_at: later, carried_to_sprint: null });
    // An undated row's carry still renews its lease to now.
    const plain = await capture('Plain');
    await steps({ nextStepAction: 'carry', nextStepIds: [plain] });
    expect(Date.now() - Date.parse(row(plain).resolved_at!)).toBeLessThan(60_000);
    // So does a full stamp ahead of now, as another machine's clock can write: only a date waits.
    db.prepare('UPDATE next_steps SET resolved_at = ? WHERE id = ?').run(at(2), plain);
    await steps({ nextStepAction: 'carry', nextStepIds: [plain] });
    expect(Math.abs(Date.now() - Date.parse(row(plain).resolved_at!))).toBeLessThan(60_000);
  });

  it("loses its date to 4.9.0's carry, as the CHANGELOG says, and keeps it through 4.9.0's reopen", async () => {
    const day = dayAt(30);
    const id = await capture('Older runtimes', day);
    db.prepare(V490.reopen).run(id);
    expect(row(id)).toEqual({ status: 'pending', resolved_at: day, carried_to_sprint: null });
    const now = new Date().toISOString();
    db.prepare(V490.carry).run(now, null, id);
    expect(row(id).resolved_at).toBe(now);
  });

  it("is kept by 4.9.0's close: its lease SQL gives 0 closes and a negative age", async () => {
    const id = await capture('Survives an older close', dayAt(30));
    for (const [index, ago] of [20, 15, 10, 5].entries())
      await sprint(`old-${index}`, 'Completed', ago);
    const aged = db
      .prepare(
        `SELECT ${V490.closesSurvived} AS closes, ${V490.ageDays} AS age FROM next_steps n WHERE id = ?`
      )
      .get(id) as { closes: number; age: number };
    expect(aged.closes).toBe(0);
    expect(aged.age).toBeLessThan(-29);
    // 4.9.0's own close survey, beside an undated row it does drop: the dated row is not lapsed.
    const control = await capture('Lapses under an older close');
    db.prepare('UPDATE next_steps SET created_at = ? WHERE id = ?').run(at(-40), control);
    const surveyed = db.prepare(V490.survey).all() as Array<{
      id: number;
      closes_survived: number;
      age_days: number;
    }>;
    const lapsed = surveyed.filter(
      (entry) => leaseState(entry.closes_survived, entry.age_days) === 'lapsing'
    );
    expect(lapsed.map((entry) => entry.id)).toEqual([control]);
  });

  it('is cleared to now by a 4.10.0 reopen, which is how a date ends early', async () => {
    const id = await capture('Reopen ends the wait', dayAt(30));
    expect((await steps({ nextStepAction: 'reopen', nextStepIds: [id] })).data?.affected).toBe(1);
    const reopened = row(id);
    expect(reopened.status).toBe('pending');
    expect(Date.now() - Date.parse(reopened.resolved_at!)).toBeLessThan(60_000);
    expect((await show(id)).item.waitsUntil).toBeUndefined();
  });

  it('is left out of the digest and onboard, which say how many wait', async () => {
    await capture('Waiting one', dayAt(10));
    const open = await capture('Open one');
    const work = await client((c) => digestWork(c, 'builder', getProjectId(c), null));
    expect(work.nextSteps!.rows.map((entry) => entry.id)).toEqual([`n:${open}`]);
    expect(work.waiting).toBe(1);
    expect(work.nextSteps!.total).toBe(1);
  });

  it('is not counted by the lapsing signal, whose rule names the date', async () => {
    await capture('Not lapsing', dayAt(10));
    const file = project.dbPath;
    const read = new Database(file, { readonly: true });
    try {
      const report = computeSignals(read, { now: new Date(), storePath: file });
      const entry = report.signals.find((signal) => signal.kind === 'next_steps_lapsing')!;
      expect(entry.count).toBe(0);
      expect(report.rules.next_steps_lapsing).toContain('the day a dated row waits until');
    } finally {
      read.close();
    }
  });

  it('warns when a repeated capture brings another date, and names the carry that sets it', async () => {
    const id = await capture('Same text', dayAt(10));
    const again = await rbookSession({
      action: 'capture',
      category: 'next-step',
      content: 'Same text',
      checkAfter: dayAt(20),
      projectRoot: root(),
    });
    expect((again.data as { nextStepId: number }).nextStepId).toBe(id);
    expect(again.warnings?.join(' ')).toContain(
      `rbook_context(action="next_steps", nextStepAction="carry", nextStepIds=[${id}], checkAfter="${dayAt(20)}")`
    );
    expect(row(id).resolved_at).toBe(dayAt(10));
  });
});

describe('a next step reason', () => {
  it('shows with the completion it explains, is deleted by a reopen and survives a renumber', async () => {
    const id = await capture('Ship the fix');
    const done = await steps({
      nextStepAction: 'complete',
      nextStepIds: [id],
      reason: 'Shipped in 4.10.0',
    });
    expect(done.data?.affected).toBe(1);
    expect((await show(id)).item.reason).toBe('Shipped in 4.10.0');
    expect((await show(id)).text).toContain('    Reason: Shipped in 4.10.0');

    const stable = (
      db.prepare('SELECT stable_event_id AS s FROM next_steps WHERE id = ?').get(id) as {
        s: string;
      }
    ).s;
    await client((c) => renameNumberedRow(c, 'next_steps', stable, id, id + 100));
    expect((await show(id + 100)).item.reason).toBe('Shipped in 4.10.0');

    await steps({ nextStepAction: 'reopen', nextStepIds: [id + 100] });
    expect(db.prepare('SELECT COUNT(*) AS c FROM next_step_reasons').get()).toEqual({ c: 0 });
    expect((await show(id + 100)).item.reason).toBeUndefined();
  });

  it("is hidden once an older release's reopen or spin-out's drop changes the row, and replaced by a later one", async () => {
    const id = await capture('Hidden then replaced');
    await steps({ nextStepAction: 'drop', nextStepIds: [id], reason: 'Not needed' });
    // spin-out-mark.ts sets the status alone, so a drop's reason must not explain it.
    db.prepare("UPDATE next_steps SET status = 'completed' WHERE id = ?").run(id);
    expect((await show(id)).item.reason).toBeUndefined();
    db.prepare(V490.reopen).run(id);
    expect((await show(id)).item.reason).toBeUndefined();
    await steps({ nextStepAction: 'complete', nextStepIds: [id], reason: 'Done after all' });
    expect((await show(id)).item.reason).toBe('Done after all');
    expect(db.prepare('SELECT COUNT(*) AS c FROM next_step_reasons').get()).toEqual({ c: 1 });
  });

  it('is refused over 500 characters and when the sanitizer empties it, and a blank one is none', async () => {
    const id = await capture('Refusals');
    // Characters are code points: 500 emoji fit, though each is two UTF-16 units.
    const emoji = await capture('Emoji reason');
    const fits = await steps({
      nextStepAction: 'complete',
      nextStepIds: [emoji],
      reason: '🙂'.repeat(500),
    });
    expect(fits.data?.affected).toBe(1);
    const long = await steps({
      nextStepAction: 'complete',
      nextStepIds: [id],
      reason: 'x'.repeat(501),
    });
    expect(long.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'reason' });
    expect(long.error?.message).toContain('at most 500');
    const emptied = await steps({
      nextStepAction: 'drop',
      nextStepIds: [id],
      reason: '<parameter name="x">',
    });
    expect(emptied.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'reason' });
    expect(row(id).status).toBe('pending');
    // A blank reason is no reason, as null is.
    expect(
      (await steps({ nextStepAction: 'complete', nextStepIds: [id], reason: '  ' })).data?.affected
    ).toBe(1);
  });
});
