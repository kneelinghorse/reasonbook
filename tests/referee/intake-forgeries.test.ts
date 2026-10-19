// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m09 critics, round 1 — the forgeries the security lens reproduced, each refused whole at intake: a change joining
// ABOUTME: another copy's transaction, ids taken from another block, a stream that skips ahead, a forged clock or author.
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { monotonicFactory } from 'ulid';
import fs from 'fs';
import path from 'path';
import { writeUserAuthor } from '../../src/intelligence/user-author';
import {
  exportSnapshot,
  peer,
  REFEREE_ERROR_CODES,
  refereeStatus,
  type Caller,
} from '../../src/referee';
import { importCopy } from '../../src/tools/rbook/record-import';
import { LATEST_READING_MS } from '../../src/tools/rbook/record-intake';
import { changesSince } from '../../src/tools/rbook/record-since';
import type { LoggedChange } from '../../src/tools/rbook/record-standing';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import {
  ask,
  callerOf,
  hostProject,
  joinThroughReferee,
  syncWithReferee,
  type Hosted,
  type Referee,
} from '../helpers/referee-fixture';
import { onCopy, read, type Copy } from '../helpers/shared-copies';

const mint = monotonicFactory();
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-forgery-');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

function onReferee<T>(referee: Referee, sql: string, params: unknown[] = []): T[] {
  const db = new Database(referee.storePath, { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
const stored = (referee: Referee): number =>
  onReferee<{ n: number }>(referee, 'SELECT count(*) AS n FROM record_changes')[0].n;

async function pendingOf(copy: Copy, referee: Referee): Promise<LoggedChange[]> {
  const marks = Object.fromEntries(
    onReferee<{ replica_id: string; seq: number }>(
      referee,
      'SELECT replica_id, max(replica_seq) AS seq FROM record_changes GROUP BY replica_id'
    ).map((row) => [row.replica_id, row.seq])
  );
  return onCopy(fixture.tmp, copy, (client) => changesSince(client, marks), {
    replicaCheck: false,
  });
}

/** Darryl's next change, shaped as his copy writes one, with the fields a forger changes. */
async function nextOf(
  darryl: Copy,
  d: Caller,
  fields: Partial<LoggedChange>
): Promise<LoggedChange> {
  const [last] = read<LoggedChange>(
    darryl,
    'SELECT * FROM record_changes WHERE replica_id = ? ORDER BY replica_seq DESC LIMIT 1',
    [d.replicaId]
  );
  return {
    ...last,
    change_id: mint(),
    txn_id: mint(),
    replica_seq: last.replica_seq + 1,
    base: null,
    ...fields,
  };
}

async function setUp(): Promise<{ hosted: Hosted; darryl: Copy; d: Caller }> {
  const hosted = await hostProject(fixture.tmp);
  const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
  await on(darryl, 'rbook_decisions', { action: 'record', content: 'Darryl decided this first.' });
  await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
  await on(hosted.owner, 'rbook_decisions', {
    action: 'record',
    content: 'The owner decided this.',
  });
  await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
  return { hosted, darryl, d: await callerOf(fixture.tmp, darryl, 'acct-darryl') };
}

const apply = (referee: Referee, changes: unknown, caller: Caller) =>
  ask(referee, (location) => peer(location, 'apply', { changes }, caller));

describe("what a member cannot slip past the referee's intake (s97-m09 critics, round 1)", () => {
  it("refuses a change that joins the referee's, the owner's or its own already-held transaction", async () => {
    const { hosted, darryl, d } = await setUp();
    const { referee } = hosted;
    const txnOf = (sql: string, params: unknown[]) =>
      onReferee<{ txn_id: string }>(referee, sql, params)[0].txn_id;
    const targets = {
      // The referee's own verdict: a change in it would read as the authority's own write.
      "the referee's": txnOf(
        "SELECT txn_id FROM record_changes WHERE replica_id = ? AND kind = 'verdict' LIMIT 1",
        [hosted.refereeReplica]
      ),
      // The owner's decision: a change in it with a gap would hold it, and hide the decision.
      "the owner's": txnOf(
        "SELECT txn_id FROM record_changes WHERE kind = 'create' AND entity = 'strategic_decisions' AND author_name = 'Owner' ORDER BY rowid DESC LIMIT 1",
        []
      ),
      // His own judged transaction: a new change in it would never be judged.
      'his own': txnOf('SELECT txn_id FROM record_changes WHERE replica_id = ? LIMIT 1', [
        d.replicaId,
      ]),
    };
    const before = stored(referee);
    for (const [whose, txn] of Object.entries(targets)) {
      const forged = await nextOf(darryl, d, {
        txn_id: txn,
        kind: 'set',
        entity: 'project',
        entity_id: 'p-shared',
        field: 'metadata.project_name',
        value: JSON.stringify(`Renamed into ${whose} transaction`),
      });
      const refused = await apply(referee, [forged], d);
      expect({ whose, code: refused.error?.code, message: refused.error?.message }).toEqual({
        whose,
        code: REFEREE_ERROR_CODES.FORGED_REPLICA,
        message: expect.stringMatching(/joins transaction/),
      });
    }
    expect(stored(referee)).toBe(before);
    expect(
      read(
        hosted.owner,
        "SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = 'The owner decided this.'"
      )
    ).toEqual([{ n: 1 }]);
  }, 240000);

  it("refuses ids taken from another copy's block, a stream that skips ahead, a forged clock and another's name", async () => {
    const { hosted, darryl, d } = await setUp();
    const { referee } = hosted;
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Darryl decided this second.',
    });
    const honest = await pendingOf(darryl, referee);
    const create = honest.find(
      (change) => change.kind === 'create' && change.entity === 'strategic_decisions'
    )!;
    const value = JSON.parse(create.value!) as Record<string, unknown>;
    const forgeries: Array<[string, LoggedChange[], string]> = [
      [
        "the top of the owner's block 0",
        honest.map((change) =>
          change === create
            ? { ...change, value: JSON.stringify({ ...value, id: 1_000_000 }) }
            : change
        ),
        REFEREE_ERROR_CODES.FORGED_RENUMBER,
      ],
      [
        "the owner's next id",
        honest.map((change) =>
          change === create ? { ...change, value: JSON.stringify({ ...value, id: 2 }) } : change
        ),
        REFEREE_ERROR_CODES.FORGED_RENUMBER,
      ],
      [
        'a stream that skips a billion changes ahead',
        honest.map((change) => ({ ...change, replica_seq: change.replica_seq + 1_000_000_000 })),
        REFEREE_ERROR_CODES.MALFORMED,
      ],
      [
        'a clock that is no reading',
        honest.map((change) => ({ ...change, hlc: 'yesterday' })),
        REFEREE_ERROR_CODES.MALFORMED,
      ],
      [
        'a clock read far in the future',
        honest.map((change) => ({ ...change, hlc: '9999999999999-999999' })),
        REFEREE_ERROR_CODES.MALFORMED,
      ],
      [
        "the owner's name as its author",
        honest.map((change) => ({ ...change, author_name: 'Owner' })),
        REFEREE_ERROR_CODES.FORGED_REPLICA,
      ],
    ];
    const before = stored(referee);
    for (const [what, changes, code] of forgeries)
      expect({ what, code: (await apply(referee, changes, d)).error?.code }).toEqual({
        what,
        code,
      });
    expect(stored(referee)).toBe(before);
    // The honest delivery itself goes in whole.
    expect((await apply(referee, honest, d)).error).toBeUndefined();
  }, 240000);

  it("takes a successor only from the outgoing authority, for the referee's own replica", async () => {
    const { hosted, d } = await setUp();
    const owner = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
    for (const caller of [owner, d])
      expect(
        (
          await ask(hosted.referee, (location) =>
            peer(
              location,
              'takeSuccessor',
              {
                successor: { replicaId: d.replicaId, block: 1, role: 'owner', member: 'owner' },
                reason: 'block',
                authorityReceived: null,
              },
              caller
            )
          )
        ).error?.code
      ).toBe(REFEREE_ERROR_CODES.METHOD_REFUSED);
  }, 240000);

  it('round 2: a clock count at its last value carries, so exports, first copies and the owner keep working', async () => {
    const { hosted, darryl, d } = await setUp();
    const { referee } = hosted;
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Written at the end of a count.',
    });
    const ahead = Date.now() + 60 * 60 * 1000;
    const edge = (await pendingOf(darryl, referee)).map((change) => ({
      ...change,
      hlc: `${String(ahead).padStart(13, '0')}-999999`,
    }));
    expect((await apply(referee, edge, d)).error).toBeUndefined();
    const [verdict] = onReferee<{ hlc: string }>(
      referee,
      "SELECT hlc FROM record_changes WHERE replica_id = ? AND kind = 'verdict' ORDER BY replica_seq DESC LIMIT 1",
      [hosted.refereeReplica]
    );
    expect(verdict.hlc).toBe(`${String(ahead + 1).padStart(13, '0')}-000000`);
    const out = path.join(fixture.tmp, 'export', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    expect((await ask(referee, (location) => exportSnapshot(location, out))).error).toBeUndefined();
    // The owner takes the referee's clock and keeps writing and syncing.
    await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
    await on(hosted.owner, 'rbook_decisions', {
      action: 'record',
      content: 'Written after the carry.',
    });
    await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
    expect(
      read(
        hosted.owner,
        "SELECT hlc FROM record_changes WHERE hlc NOT GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'"
      )
    ).toEqual([]);
  }, 240000);

  it('round 2: a clock once days ahead still syncs; one past 2200, or before its copy was admitted, does not', async () => {
    const { hosted, darryl, d } = await setUp();
    const { referee } = hosted;
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Written on a skewed clock.',
    });
    const honest = await pendingOf(darryl, referee);
    const at = (ms: number) => `${String(ms).padStart(13, '0')}-000001`;
    const before = stored(referee);
    for (const [what, hlc, code] of [
      ['past the year 2200', at(Date.UTC(2286, 0, 1)), REFEREE_ERROR_CODES.MALFORMED],
      ['before its copy was admitted', at(1), REFEREE_ERROR_CODES.FORGED_REPLICA],
    ] as const)
      expect({
        what,
        code: (
          await apply(
            referee,
            honest.map((change) => ({ ...change, hlc })),
            d
          )
        ).error?.code,
      }).toEqual({ what, code });
    expect(stored(referee)).toBe(before);
    const DAY = 24 * 60 * 60 * 1000;
    const skewed = honest.map((change) => ({ ...change, hlc: at(Date.now() + 3 * DAY) }));
    expect((await apply(referee, skewed, d)).error).toBeUndefined();
    const taken = stored(referee);
    // Round 3: more than a week past the referee's clock waits on its copy, refused without a verdict,
    // and goes in once the referee's clock is within a week of it.
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Written on a clock eight days ahead.',
    });
    const early = (await pendingOf(darryl, referee)).map((change) => ({
      ...change,
      hlc: at(Date.now() + 8 * DAY),
    }));
    const waits = await apply(referee, early, d);
    expect({ code: waits.error?.code, status: refereeStatus(waits) }).toEqual({
      code: REFEREE_ERROR_CODES.CLOCK_AHEAD,
      status: 409,
    });
    expect(stored(referee)).toBe(taken);
    const real = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => real() + 2 * DAY);
    expect((await apply(referee, early, d)).error).toBeUndefined();
  }, 240000);

  it('round 3: a reading just short of 2200 waits on its copy, so no copy takes a clock past it', async () => {
    const { hosted, darryl, d } = await setUp();
    const { referee } = hosted;
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'Darryl, at the edge.' });
    const clock = () =>
      onReferee<{ value: string }>(referee, "SELECT value FROM metadata WHERE key = 'replica_hlc'");
    const [before, held] = [stored(referee), clock()];
    const edge = `${String(LATEST_READING_MS - 1).padStart(13, '0')}-999999`;
    const forged = (await pendingOf(darryl, referee)).map((change) => ({ ...change, hlc: edge }));
    expect((await apply(referee, forged, d)).error?.code).toBe(REFEREE_ERROR_CODES.CLOCK_AHEAD);
    expect({ stored: stored(referee), clock: clock() }).toEqual({ stored: before, clock: held });
    // The owner, a member who joins now and Darryl's own copy keep writing and syncing.
    for (const round of [1, 2]) {
      await on(hosted.owner, 'rbook_decisions', {
        action: 'record',
        content: `The owner, after the edge, ${round}.`,
      });
      await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
    }
    const carol = await joinThroughReferee(fixture.tmp, hosted, 'carol', 'acct-carol');
    await on(carol, 'rbook_decisions', { action: 'record', content: 'Carol, after the edge.' });
    await syncWithReferee(fixture.tmp, hosted, carol, 'acct-carol');
    await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
    const [latest] = onReferee<{ hlc: string }>(
      referee,
      'SELECT max(hlc) AS hlc FROM record_changes'
    );
    expect(Number(latest.hlc.slice(0, 13))).toBeLessThan(Date.now() + 60 * 60 * 1000);
  }, 300000);

  it('round 3: rows a member imports keep the authors who wrote them, and its copy syncs on', async () => {
    const ownerRoot = project(fixture.tmp, 'owner');
    const shared = "The owner's decision, which Darryl's old copy holds under another author.";
    expect(
      (await call('rbook_decisions', { action: 'record', content: shared, projectRoot: ownerRoot }))
        .success
    ).toBe(true);
    // Darryl's copy from before the share, with work of his own under his laptop's name.
    const oldRoot = path.join(fixture.tmp, 'darryl-old');
    fs.mkdirSync(path.dirname(dbOf(oldRoot)), { recursive: true });
    const source = new Database(dbOf(ownerRoot));
    source.exec(`VACUUM INTO '${dbOf(oldRoot)}'`);
    source.close();
    const old = new Database(dbOf(oldRoot));
    old
      .prepare(
        "UPDATE strategic_decisions SET author_name = 'Darryl Laptop' WHERE decision_text = ?"
      )
      .run(shared);
    old.close();
    useMachine(fixture.tmp, 'machine-darryl');
    writeUserAuthor('Darryl Laptop');
    const text = 'Darryl decided this before the share.';
    expect(
      (await call('rbook_decisions', { action: 'record', content: text, projectRoot: oldRoot }))
        .success
    ).toBe(true);
    const hosted = await hostProject(fixture.tmp, { realStore: ownerRoot });
    const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
    const imported = await onCopy(fixture.tmp, darryl, (client) =>
      importCopy(client, oldRoot, { apply: true })
    );
    expect(imported.error).toBeUndefined();
    await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
    // The row keeps the author who wrote it; its change names the member who brought it in.
    expect(
      onReferee(
        hosted.referee,
        `SELECT d.author_name AS row, c.author_name AS change FROM strategic_decisions d
           JOIN record_changes c ON c.entity = 'strategic_decisions' AND c.entity_id = d.stable_event_id
            AND c.kind = 'create' WHERE d.decision_text = ?`,
        [text]
      )
    ).toEqual([{ row: 'Darryl Laptop', change: 'darryl' }]);
    // The import also sets the author of a row the owner made, which the referee takes in as well.
    expect(
      onReferee(
        hosted.referee,
        `SELECT c.author_name AS change, c.value FROM record_changes c
           JOIN strategic_decisions d ON c.entity = 'strategic_decisions' AND c.entity_id = d.stable_event_id
          WHERE c.kind = 'set' AND c.field = 'author_name' AND d.decision_text = ?`,
        [shared]
      )
    ).toEqual([{ change: 'darryl', value: '"Darryl Laptop"' }]);
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Darryl decided this after.',
    });
    await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
  }, 300000);

  it("round 2: no delivered change rewrites a row's id; round 3: a row's own author goes in as its content", async () => {
    const { hosted, darryl, d } = await setUp();
    const { referee } = hosted;
    const [row] = onReferee<{ stable_event_id: string }>(
      referee,
      "SELECT stable_event_id FROM strategic_decisions WHERE author_name = 'Owner' LIMIT 1"
    );
    const setId = await nextOf(darryl, d, {
      kind: 'set',
      entity: 'strategic_decisions',
      entity_id: row.stable_event_id,
      field: 'id',
      value: '1000000',
    });
    expect((await apply(referee, [setId], d)).error?.code).toBe(
      REFEREE_ERROR_CODES.FORGED_RENUMBER
    );
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Darryl decided this third.',
    });
    const honest = await pendingOf(darryl, referee);
    const create = honest.find(
      (change) => change.kind === 'create' && change.entity === 'strategic_decisions'
    )!;
    const asOwner = honest.map((change) =>
      change === create
        ? {
            ...change,
            value: JSON.stringify({ ...JSON.parse(change.value!), author_name: 'Owner' }),
          }
        : change
    );
    // An import brings rows in under the authors who wrote them, so the referee cannot tell this row's
    // author from one of those; the change itself still names the member who made it (round 3).
    expect((await apply(referee, asOwner, d)).error).toBeUndefined();
    expect(
      onReferee(
        referee,
        "SELECT author_name AS change, json_extract(value, '$.author_name') AS row FROM record_changes WHERE change_id = ?",
        [create.change_id]
      )
    ).toEqual([{ change: 'darryl', row: 'Owner' }]);
  }, 240000);
});
