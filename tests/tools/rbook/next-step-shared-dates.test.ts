// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m02 — on a shared record a next step's date travels to every copy, a member's close keeps
// ABOUTME: the row, a 4.10.0 carry keeps the later anchor, and a date and a concurrent carry conflict.

import Database from 'better-sqlite3';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { utcDay } from '../../../src/tools/rbook/next-step-dates';
import {
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import {
  joinedCopy,
  read,
  shareExisting,
  syncCopies,
  type Copy,
} from '../../helpers/shared-copies';

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();
type Where = { root: string; machine: string };

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-s108-m02-shared-');
});
afterEach(() => fixture.restore());

async function tool(where: Where, name: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, where.machine);
  RbookDetector.resetInstance();
  const result = await executeMissionProtocolTool(
    name,
    { ...args, projectRoot: where.root },
    await buildMissionProtocolContext()
  );
  const answer = result.structuredContent as unknown as {
    success: boolean;
    data?: Record<string, unknown>;
    error?: unknown;
    warnings?: string[];
  };
  if (!answer.success) throw new Error(`${name}: ${JSON.stringify(answer.error)}`);
  return answer;
}
const stableOf = (copy: Pick<Copy, 'root'>, id: number): string =>
  read<{ s: string }>(copy, 'SELECT stable_event_id AS s FROM next_steps WHERE id = ?', [id])[0].s;
const byStable = (copy: Pick<Copy, 'root'>, stable: string) =>
  read<{ id: number; status: string; resolved_at: string | null }>(
    copy,
    'SELECT id, status, resolved_at FROM next_steps WHERE stable_event_id = ?',
    [stable]
  )[0];

/** Four closes in the past, 30 to 15 days ago, and an open sprint, on the store before it is shared. */
function seedCloses(root: string): void {
  const db = new Database(dbOf(root));
  try {
    for (let index = 0; index < 4; index++)
      db.prepare(
        "INSERT INTO sprints (id, title, status, start_date, end_date) VALUES (?, ?, 'Completed', ?, ?)"
      ).run(`old-${index}`, `Old ${index}`, at(-(31 - index * 5)), at(-(30 - index * 5)));
    db.prepare(
      "INSERT INTO sprints (id, title, status) VALUES ('sprint-9', 'Closing', 'Active')"
    ).run();
  } finally {
    db.close();
  }
}

it('travels to the member, whose close keeps it, and a 4.10.0 carry on either copy keeps the later anchor', async () => {
  const root = project(fixture.tmp, 'owner');
  seedCloses(root);
  const pre = { root, machine: 'machine-owner' };
  const control = (
    await tool(pre, 'rbook_session', {
      action: 'capture',
      category: 'next-step',
      content: 'Undated control',
    })
  ).data!.nextStepId as number;
  const raw = new Database(dbOf(root));
  raw.prepare('UPDATE next_steps SET created_at = ?').run(at(-40));
  raw.close();
  // A row dated before sharing reaches the member through the fresh copy its join is built from.
  const early = utcDay(Date.now() + 30 * DAY);
  const before = (
    await tool(pre, 'rbook_session', {
      action: 'capture',
      category: 'next-step',
      content: 'Dated before the share',
      checkAfter: early,
    })
  ).data!.nextStepId as number;
  const owner = await shareExisting(fixture.tmp, root, 'owner', 'Owner');
  const member = await joinedCopy(fixture.tmp, owner, 'member');
  expect(byStable(member, stableOf(owner, before))).toMatchObject({ resolved_at: early });

  const day = utcDay(Date.now() + 45 * DAY);
  const dated = await tool(owner, 'rbook_session', {
    action: 'capture',
    category: 'next-step',
    content: 'Dated on the owner',
    checkAfter: day,
  });
  // The answer that writes a date on a shared record says what the date does there.
  expect(dated.warnings?.join(' ')).toContain('rbook_db(action="settle")');
  const stable = stableOf(owner, dated.data!.nextStepId as number);
  await syncCopies(fixture.tmp, member, owner);
  expect(byStable(member, stable)).toMatchObject({ status: 'carried', resolved_at: day });

  const closed = await tool(member, 'rbook_sprint', {
    action: 'complete',
    sprintId: 'sprint-9',
    summary: 'Member close',
  });
  const controlOnMember = byStable(member, stableOf(owner, control)).id;
  expect(closed.data!.lapsedDroppedIds).toEqual([controlOnMember]);
  // The drop travels and its reason does not, which the close's answer says.
  expect(closed.warnings?.join(' ')).toContain('exchanges do not send the reason');
  expect(byStable(member, stable)).toMatchObject({ status: 'carried', resolved_at: day });

  // A 4.10.0 carry by id on the member, then a broad one on the owner: the day stays everywhere.
  await tool(member, 'rbook_context', {
    action: 'next_steps',
    nextStepAction: 'carry',
    nextStepIds: [byStable(member, stable).id],
  });
  await syncCopies(fixture.tmp, member, owner);
  await tool(owner, 'rbook_context', { action: 'next_steps', nextStepAction: 'carry' });
  await syncCopies(fixture.tmp, member, owner);
  for (const copy of [owner, member]) expect(byStable(copy, stable).resolved_at).toBe(day);
}, 60_000);

it('conflicts when one copy dates a row while the other carries it, and the newer write shows on both', async () => {
  const root = project(fixture.tmp, 'owner');
  seedCloses(root);
  const pre = { root, machine: 'machine-owner' };
  const id = (
    await tool(pre, 'rbook_session', { action: 'capture', category: 'next-step', content: 'Raced' })
  ).data!.nextStepId as number;
  const owner = await shareExisting(fixture.tmp, root, 'owner', 'Owner');
  const member = await joinedCopy(fixture.tmp, owner, 'member');
  const stable = stableOf(owner, id);

  const dated = utcDay(Date.now() + 60 * DAY);
  await tool(owner, 'rbook_context', {
    action: 'next_steps',
    nextStepAction: 'carry',
    nextStepIds: [id],
    checkAfter: dated,
  });
  await tool(member, 'rbook_context', {
    action: 'next_steps',
    nextStepAction: 'carry',
    nextStepIds: [byStable(member, stable).id],
  });
  await syncCopies(fixture.tmp, member, owner);
  await syncCopies(fixture.tmp, member, owner);
  const conflicts = read<{ field: string }>(
    owner,
    "SELECT field FROM record_conflicts WHERE entity = 'next_steps'"
  );
  expect(conflicts.map((conflict) => conflict.field)).toContain('resolved_at');
  // The member's carry is the newer clock reading, so both copies show it: the date is gone.
  expect(byStable(owner, stable).resolved_at).toBe(byStable(member, stable).resolved_at);
  expect(byStable(owner, stable).resolved_at).toMatch(/T/);
  // Settling to the owner's value brings the bare date back on both copies, spelled as written.
  await tool(owner, 'rbook_db', {
    action: 'settle',
    table: 'next_steps',
    recordId: String(id),
    field: 'resolved_at',
    value: dated,
  });
  await syncCopies(fixture.tmp, member, owner);
  for (const copy of [owner, member]) expect(byStable(copy, stable).resolved_at).toBe(dated);
}, 60_000);

it('keeps a reason on the copy that wrote it: no change is logged for it and the member never gets one', async () => {
  const root = project(fixture.tmp, 'owner');
  seedCloses(root);
  const pre = { root, machine: 'machine-owner' };
  const id = (
    await tool(pre, 'rbook_session', {
      action: 'capture',
      category: 'next-step',
      content: 'Explained',
    })
  ).data!.nextStepId as number;
  const owner = await shareExisting(fixture.tmp, root, 'owner', 'Owner');
  const member = await joinedCopy(fixture.tmp, owner, 'member');
  const done = await tool(owner, 'rbook_context', {
    action: 'next_steps',
    nextStepAction: 'complete',
    nextStepIds: [id],
    reason: 'Only the owner knows why',
  });
  expect(done.warnings?.join(' ')).toContain(
    'exchanges do not send the reason to the other copies'
  );
  await syncCopies(fixture.tmp, member, owner);
  const stable = stableOf(owner, id);
  expect(byStable(member, stable).status).toBe('completed');
  expect(read(owner, 'SELECT reason FROM next_step_reasons')).toEqual([
    { reason: 'Only the owner knows why' },
  ]);
  expect(
    read(owner, "SELECT COUNT(*) AS c FROM record_changes WHERE entity = 'next_step_reasons'")
  ).toEqual([{ c: 0 }]);
  const memberTables = read<{ name: string }>(
    member,
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).map((table) => table.name);
  expect(memberTables).not.toContain('next_step_reasons');
}, 60_000);
