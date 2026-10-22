// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s100-m01 (settled item 6): a copy keeps a change written in a newer record protocol out of its store, with the
// ABOUTME: rest of that replica's stream, keeps exchanging, and takes it in once it upgrades; in both upgrade orders.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { makeFirstCopy } from '../../../src/referee';
import {
  PROTOCOL_VERSION,
  upgradeRecordProtocolForTesting,
} from '../../../src/tools/rbook/record-protocol';
import { NEW_KIND, NEWER, widenStore, writeAsNewerRelease } from '../../helpers/newer-protocol';
import { buildFreshCopy } from '../../../src/tools/rbook/record-fresh-copy';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import {
  ask,
  hostProject,
  joinThroughReferee,
  syncWithReferee,
} from '../../helpers/referee-fixture';
import { changesSince } from '../../../src/tools/rbook/record-apply';
import { exchange } from '../../../src/tools/rbook/record-exchange';
import {
  copyPeer,
  joinedCopy,
  ownerCopy,
  onCopy,
  read,
  syncCopies,
  type Copy,
} from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
let undo: (() => void) | null = null;
beforeEach(() => {
  fixture = replicaFixture('rbook-protocol-hold-');
});
afterEach(() => {
  undo?.();
  undo = null;
  fixture.restore();
});

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

const decisions = (copy: Copy, text: string): number =>
  read<{ n: number }>(
    copy,
    'SELECT count(*) AS n FROM strategic_decisions WHERE decision_text LIKE ?',
    [`${text}%`]
  )[0].n;
const holds = (copy: Copy, changeId: string): number =>
  read<{ n: number }>(copy, 'SELECT count(*) AS n FROM record_changes WHERE change_id = ?', [
    changeId,
  ])[0].n;
const verdictsOn = (copy: Copy, changeId: string): number =>
  read<{ n: number }>(
    copy,
    "SELECT count(*) AS n FROM record_changes WHERE kind = 'verdict' AND entity_id = (SELECT txn_id FROM record_changes WHERE change_id = ?)",
    [changeId]
  )[0].n;
/** Every logged change, as both copies must hold it once they agree. */
const logOf = (copy: Copy) =>
  read(
    copy,
    'SELECT change_id, replica_id, replica_seq, kind, protocol_version FROM record_changes ORDER BY change_id'
  );

/** This version, upgraded as a later release would upgrade it: its protocol raised, its stores' kinds widened. */
function upgradeHere(...copies: Copy[]): void {
  undo = upgradeRecordProtocolForTesting(NEWER, [NEW_KIND]);
  for (const copy of copies) widenStore(dbOf(copy.root));
}

describe('a change in a newer record protocol is held, never refused or stored (s100-m01, settled item 6)', () => {
  it('a member upgrades first: the owner keeps its stream out from the change on, judges none of it, and takes it in after upgrading', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const darryl = await joinedCopy(fixture.tmp, owner, 'darryl');
    await syncCopies(fixture.tmp, darryl, owner);
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'Before the bump.' });
    const bump = writeAsNewerRelease(dbOf(darryl.root));
    // Written after the bump, so it is held with it: the stream is taken in order.
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'After the bump.' });
    await on(owner, 'rbook_decisions', { action: 'record', content: 'The owner, meanwhile.' });

    for (let round = 0; round < 2; round += 1) {
      const report = await syncCopies(fixture.tmp, darryl, owner);
      expect(report.removed).toBe(false);
    }
    // Both directions flow: what darryl wrote before the bump, and the owner's stream back.
    expect(decisions(owner, 'Before the bump.')).toBe(1);
    expect(decisions(darryl, 'The owner, meanwhile.')).toBe(1);
    // The change and what followed it stay on darryl's copy, unstored and unjudged on the owner's.
    expect(holds(owner, bump.changeId)).toBe(0);
    expect(decisions(owner, 'After the bump.')).toBe(0);
    expect(verdictsOn(darryl, bump.changeId)).toBe(0);
    const owned = read<{ seq: number }>(
      owner,
      'SELECT max(replica_seq) AS seq FROM record_changes WHERE replica_id = ?',
      [darryl.replicaId]
    )[0].seq;
    expect(owned).toBe(bump.seq - 1);

    // The owner upgrades: the next exchange takes the held stream in, and judges it.
    upgradeHere(owner);
    await syncCopies(fixture.tmp, darryl, owner);
    expect(holds(owner, bump.changeId)).toBe(1);
    expect(decisions(owner, 'After the bump.')).toBe(1);
    expect(verdictsOn(owner, bump.changeId)).toBe(1);
    await syncCopies(fixture.tmp, darryl, owner);
    expect(logOf(darryl)).toEqual(logOf(owner));
  }, 600000);

  it('the owner upgrades first: a member keeps the owner stream out from the change on, verdicts included, and keeps sending its own', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const darryl = await joinedCopy(fixture.tmp, owner, 'darryl');
    await syncCopies(fixture.tmp, darryl, owner);
    const bump = writeAsNewerRelease(dbOf(owner.root));
    await on(owner, 'rbook_decisions', { action: 'record', content: 'The owner, after the bump.' });
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'Darryl, meanwhile.' });

    // A normal sender withholds the unreadable stream, so the receiver has no upgrade event.
    const said = await exchange(copyPeer(fixture.tmp, darryl), copyPeer(fixture.tmp, owner));
    expect(said.success).toBe(true);
    expect((said.warnings ?? []).join(' ')).not.toMatch(/record protocol|Upgrade Reasonbook/);
    // An older/unfiltered transport can still deliver it: the receiver must keep it out and warn.
    const incoming = await exchange(copyPeer(fixture.tmp, darryl), {
      ...copyPeer(fixture.tmp, owner),
      changesSince: (marks) =>
        onCopy(fixture.tmp, owner, (client) => changesSince(client, marks), {
          replicaCheck: false,
        }),
    });
    expect(incoming.success).toBe(true);
    expect(incoming.warnings?.join(' ')).toMatch(
      new RegExp(
        `a record protocol newer than this copy's ${PROTOCOL_VERSION}.*Upgrade Reasonbook here`
      )
    );
    await syncCopies(fixture.tmp, darryl, owner);
    // darryl's decision reached the owner and was judged there; its verdict, in the owner's stream
    // after the bump, waits with the rest.
    expect(decisions(owner, 'Darryl, meanwhile.')).toBe(1);
    expect(holds(darryl, bump.changeId)).toBe(0);
    expect(decisions(darryl, 'The owner, after the bump.')).toBe(0);
    const [mine] = read<{ change_id: string }>(
      darryl,
      "SELECT change_id FROM record_changes WHERE entity = 'strategic_decisions' AND kind = 'create' AND value LIKE '%Darryl, meanwhile.%'"
    );
    expect(verdictsOn(owner, mine.change_id)).toBe(1);
    expect(verdictsOn(darryl, mine.change_id)).toBe(0);

    upgradeHere(darryl);
    await syncCopies(fixture.tmp, darryl, owner);
    expect(holds(darryl, bump.changeId)).toBe(1);
    expect(decisions(darryl, 'The owner, after the bump.')).toBe(1);
    expect(verdictsOn(darryl, mine.change_id)).toBe(1);
    expect(logOf(darryl)).toEqual(logOf(owner));
  }, 600000);

  it("a dashboard's referee upgrades first: a member keeps its newer stream out and keeps syncing", async () => {
    const hosted = await hostProject(fixture.tmp);
    const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
    await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
    const bump = writeAsNewerRelease(hosted.referee.storePath);
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'Darryl, at the referee.' });
    for (let round = 0; round < 2; round += 1)
      await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
    expect(holds(darryl, bump.changeId)).toBe(0);
    const db = new Database(hosted.referee.storePath, { readonly: true });
    const taken = db
      .prepare(
        "SELECT count(*) AS n FROM strategic_decisions WHERE decision_text LIKE 'Darryl, at the referee.%'"
      )
      .get() as { n: number };
    db.close();
    expect(taken.n).toBe(1);
    // darryl upgrades: its next sync takes the referee's held stream in.
    upgradeHere(darryl);
    await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
    expect(holds(darryl, bump.changeId)).toBe(1);
  }, 600000);

  it('a join refuses a first copy written in a newer record protocol, and names the upgrade', async () => {
    const hosted = await hostProject(fixture.tmp);
    writeAsNewerRelease(hosted.referee.storePath);
    // The referee's newer release makes the first copy, in its own protocol and with its own kinds.
    const first = path.join(fixture.tmp, 'first.sqlite');
    const back = upgradeRecordProtocolForTesting(NEWER, [NEW_KIND]);
    try {
      expect(
        (await ask(hosted.referee, (location) => makeFirstCopy(location, first))).success
      ).toBe(true);
    } finally {
      back();
    }
    const joining = path.join(fixture.tmp, 'joining', 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(joining), { recursive: true });
    await expect(buildFreshCopy(first, joining, { untrusted: true })).rejects.toMatchObject({
      message: expect.stringMatching(new RegExp(`record protocol ${NEWER}`)),
      remedy: expect.stringMatching(/Upgrade Reasonbook/),
    });
  }, 600000);
});
