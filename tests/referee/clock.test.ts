// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s100-m01 (the sprint-97 review's finding 10): a referee whose clock once ran ahead stops no copy, since intake
// ABOUTME: bounds a change by the later of real time plus a week and the referee's own clock, and no member pushes it on.
import Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import fs from 'fs';
import path from 'path';
import { createReferee, makeFirstCopy, peer } from '../../src/referee';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import { MAX_AHEAD_MS, runsAhead } from '../../src/tools/rbook/record-intake';
import type { LoggedChange } from '../../src/tools/rbook/record-standing';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import {
  ask,
  callerOf,
  hostProject,
  joinThroughReferee,
  refereeAt,
  syncWithReferee,
  type Referee,
} from '../helpers/referee-fixture';
import { read, type Copy } from '../helpers/shared-copies';

const mint = monotonicFactory();
const DAY = 24 * 3600 * 1000;
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-clock-');
});
afterEach(() => fixture.restore());

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

const reading = (ms: number, count = 0): string =>
  `${String(ms).padStart(13, '0')}-${String(count).padStart(6, '0')}`;

function setClock(storePath: string, hlc: string): void {
  const db = new Database(storePath);
  try {
    db.prepare("UPDATE metadata SET value = ? WHERE key = 'replica_hlc'").run(hlc);
  } finally {
    db.close();
  }
}

const refereeClock = (referee: Referee): string => {
  const db = new Database(referee.storePath, { readonly: true });
  try {
    return (
      db.prepare("SELECT value FROM metadata WHERE key = 'replica_hlc'").get() as { value: string }
    ).value;
  } finally {
    db.close();
  }
};

const decisions = (copy: Copy, text: string): number =>
  read<{ n: number }>(
    copy,
    'SELECT count(*) AS n FROM strategic_decisions WHERE decision_text LIKE ?',
    [`${text}%`]
  )[0].n;

/** A project two members share through the referee, both synced. */
async function twoMembers() {
  const hosted = await hostProject(fixture.tmp);
  const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
  const erin = await joinThroughReferee(fixture.tmp, hosted, 'erin', 'acct-erin');
  await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
  await syncWithReferee(fixture.tmp, hosted, erin, 'acct-erin');
  return { hosted, darryl, erin };
}

/**
 * darryl's replica delivers a change of its own decision's status itself, at a clock reading it
 * chooses, as any client could: the next in its stream, based on the last status change the referee
 * holds. darryl's copy first archives a decision, whose status change is the shape copied.
 */
async function statusChanges(hosted: { referee: Referee }, copy: Copy) {
  const recorded = await on(copy, 'rbook_decisions', {
    action: 'record',
    content: 'A shape to copy.',
  });
  const decisionId =
    (recorded.data as { decisionId?: number; id?: number }).decisionId ??
    (recorded.data as { id?: number }).id;
  await on(copy, 'rbook_decisions', { action: 'update', decisionId, status: 'archived' });
  await syncWithReferee(fixture.tmp, hosted, copy, 'acct-darryl');
  const caller = await callerOf(fixture.tmp, copy, 'acct-darryl');
  const [shape] = read<LoggedChange>(
    copy,
    "SELECT * FROM record_changes WHERE replica_id = ? AND entity = 'strategic_decisions' AND field = 'status' ORDER BY rowid DESC LIMIT 1",
    [caller.replicaId]
  );
  let flip = false;
  return async (hlc: string) => {
    const db = new Database(hosted.referee.storePath, { readonly: true });
    const [{ seq }] = db
      .prepare('SELECT max(replica_seq) AS seq FROM record_changes WHERE replica_id = ?')
      .all(caller.replicaId) as Array<{ seq: number | null }>;
    const [last] = db
      .prepare(
        "SELECT change_id FROM record_changes WHERE entity_id = ? AND field = 'status' ORDER BY rowid DESC LIMIT 1"
      )
      .all(shape.entity_id) as Array<{ change_id: string }>;
    db.close();
    flip = !flip;
    const change: LoggedChange = {
      ...shape,
      change_id: mint(),
      txn_id: mint(),
      replica_seq: (seq ?? 0) + 1,
      hlc,
      value: JSON.stringify(flip ? 'active' : 'archived'),
      base: JSON.stringify([last.change_id]),
    };
    return (await ask(hosted.referee, (location) =>
      peer(location, 'apply', { changes: [change] }, caller)
    )) as { success: boolean; error?: { code: string; message: string; suggestion?: string } };
  };
}

describe('a referee clock that ran ahead (s100-m01, settled item 7)', () => {
  it("stops no copy: members keep writing at the referee's reading and exchange both ways", async () => {
    const { hosted, darryl, erin } = await twoMembers();
    // The dashboard host's clock ran 30 days ahead at the referee's last write, then was put right;
    // the referee's hybrid clock keeps that reading (record-changes.ts never moves a clock back).
    setClock(hosted.referee.storePath, reading(Date.now() + 30 * DAY));
    await on(erin, 'rbook_decisions', { action: 'record', content: 'Erin before.' });
    await syncWithReferee(fixture.tmp, hosted, erin, 'acct-erin');
    await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
    // Both copies took the ahead reading from the verdict, and write at it from now on.
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'Darryl after.' });
    await on(erin, 'rbook_decisions', { action: 'record', content: 'Erin after.' });
    await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
    await syncWithReferee(fixture.tmp, hosted, erin, 'acct-erin');
    await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
    expect(decisions(darryl, 'Erin after.')).toBe(1);
    expect(decisions(erin, 'Darryl after.')).toBe(1);
  }, 600000);

  it('lets no member push the clock past its own millisecond, nor past real time plus a week', async () => {
    const { hosted, darryl } = await twoMembers();
    const deliver = await statusChanges(hosted, darryl);
    const ahead = Date.now() + 30 * DAY;
    setClock(hosted.referee.storePath, reading(ahead, 5));
    // A reading one millisecond past the referee's is refused, and the clock stays where it was.
    const pushed = await deliver(reading(ahead + 1));
    expect(pushed.success).toBe(false);
    expect(pushed.error?.code).toBe('REFEREE_CLOCK_AHEAD');
    expect(refereeClock(hosted.referee)).toBe(reading(ahead, 5));
    // At the referee's own millisecond a copy counts up, as copies that adopted it do.
    const same = await deliver(reading(ahead, 9));
    expect(same.success).toBe(true);
    expect(refereeClock(hosted.referee) >= reading(ahead, 9)).toBe(true);
    expect(refereeClock(hosted.referee).slice(0, 13)).toBe(reading(ahead).slice(0, 13));
  }, 600000);

  it('bounds a referee on real time by real time plus a week, so its clock is never carried past it', async () => {
    const { hosted, darryl } = await twoMembers();
    const deliver = await statusChanges(hosted, darryl);
    expect((await deliver(reading(Date.now() + 6 * DAY))).success).toBe(true);
    const far = await deliver(reading(Date.now() + MAX_AHEAD_MS + DAY));
    expect(far.error?.code).toBe('REFEREE_CLOCK_AHEAD');
    expect(Number(refereeClock(hosted.referee).slice(0, 13))).toBeLessThanOrEqual(
      Date.now() + MAX_AHEAD_MS
    );
    // The remedy names what helps the copy that sent it: its own clock, and real time catching up.
    expect(far.error?.suggestion).toMatch(/set it right/);
  }, 600000);

  it('lets a member join through a referee whose clock ran ahead: the first copy it builds keeps that reading', async () => {
    const { hosted } = await twoMembers();
    const ahead = Date.now() + 30 * DAY;
    setClock(hosted.referee.storePath, reading(ahead));
    const first = path.join(fixture.tmp, 'first.sqlite');
    expect((await ask(hosted.referee, (location) => makeFirstCopy(location, first))).success).toBe(
      true
    );
    // A join rebuilds the download as this version's store (record-dashboard-join.ts).
    const joining = path.join(fixture.tmp, 'joining', 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(joining), { recursive: true });
    await expect(buildFreshCopy(first, joining, { untrusted: true })).resolves.toBeDefined();
    // An upload that would make a referee is still held to real time plus a week.
    const upload = path.join(fixture.tmp, 'upload.sqlite');
    await buildFreshCopy(dbOf(hosted.owner.root), upload);
    setClock(upload, reading(ahead));
    const refused = await ask(refereeAt(fixture.tmp, 'other'), (location) =>
      createReferee(location, { copyFile: upload, ownerAccountId: 'acct-owner' })
    );
    expect(refused.error?.message).toMatch(/more than a week ahead/);
  }, 600000);

  it("the hole left open: a copy writing a million transactions in one of the referee's milliseconds carries past it and waits", async () => {
    const { hosted, darryl } = await twoMembers();
    const ahead = Date.now() + 30 * DAY;
    setClock(hosted.referee.storePath, reading(ahead));
    // darryl adopted the referee's reading and counted up to the last its six digits hold.
    setClock(dbOf(darryl.root), reading(ahead, 999_999));
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'Past the count.' });
    const [{ hlc }] = read<{ hlc: string }>(
      darryl,
      "SELECT hlc FROM record_changes WHERE entity = 'strategic_decisions' ORDER BY rowid DESC LIMIT 1"
    );
    // Past the six digits the count carries into the next millisecond (record-changes.ts).
    expect(hlc.slice(0, 13)).toBe(reading(ahead + 1).slice(0, 13));
    await expect(syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl')).rejects.toThrow(
      /REFEREE_CLOCK_AHEAD/
    );
    expect(decisions(darryl, 'Past the count.')).toBe(1);
  }, 600000);
});

describe('the bound itself (s100-m01, critics round 1)', () => {
  it('falls back to real time plus a week when the referee holds no clock, or one that is no reading', () => {
    const now = Date.now();
    const past = reading(now + MAX_AHEAD_MS + DAY);
    for (const held of [null, 'not-a-reading', reading(now)])
      expect(runsAhead(past, now, held)).toBe(true);
    expect(runsAhead(reading(now + 6 * DAY), now, null)).toBe(false);
    // A clock the referee holds ahead raises the bound to its own millisecond, and no further.
    const ahead = now + 30 * DAY;
    expect(runsAhead(reading(ahead, 999_999), now, reading(ahead))).toBe(false);
    expect(runsAhead(reading(ahead + 1), now, reading(ahead))).toBe(true);
  });
});
