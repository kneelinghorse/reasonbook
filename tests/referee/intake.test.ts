// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m09 (design §R1, intake) — the referee checks every change of a delivery before storing any: a malformed one,
// ABOUTME: one in a newer protocol (kept on its copy, never given a refused verdict) or a forged renumber refuses it whole.
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { monotonicFactory } from 'ulid';
import { peer, REFEREE_ERROR_CODES, type Caller } from '../../src/referee';
import { PROTOCOL_VERSION } from '../../src/tools/rbook/record-changes';
import { exchange } from '../../src/tools/rbook/record-exchange';
import { changesSince } from '../../src/tools/rbook/record-since';
import type { LoggedChange } from '../../src/tools/rbook/record-standing';
import { call, replicaFixture, useMachine, type ReplicaFixture } from '../helpers/replica-fixture';
import {
  ask,
  callerOf,
  hostProject,
  joinThroughReferee,
  refereePeer,
  syncWithReferee,
  type Hosted,
  type Referee,
} from '../helpers/referee-fixture';
import { backUp, copyPeer, onCopy, type Copy } from '../helpers/shared-copies';

const mint = monotonicFactory();
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-intake-');
});
afterEach(() => fixture.restore());

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

function onReferee<T>(referee: Referee, sql: string): T[] {
  const db = new Database(referee.storePath, { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}
const count = (referee: Referee, where = '1'): number =>
  onReferee<{ n: number }>(referee, `SELECT count(*) AS n FROM record_changes WHERE ${where}`)[0].n;

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

async function darrylWrote(): Promise<{
  hosted: Hosted;
  darryl: Copy;
  d: Caller;
  changes: LoggedChange[];
}> {
  const hosted = await hostProject(fixture.tmp);
  const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
  await on(darryl, 'rbook_decisions', { action: 'record', content: 'Darryl decided this.' });
  return {
    hosted,
    darryl,
    d: await callerOf(fixture.tmp, darryl, 'acct-darryl'),
    changes: await pendingOf(darryl, hosted.referee),
  };
}

const apply = (referee: Referee, changes: unknown, caller: Caller) =>
  ask(referee, (location) => peer(location, 'apply', { changes }, caller));

describe('what the referee takes in (s97-m09)', () => {
  it('refuses a whole delivery when one change is malformed, storing none of it', async () => {
    const { hosted, d, changes } = await darrylWrote();
    const [first, ...rest] = changes;
    const before = count(hosted.referee);
    const broken: Array<[string, Record<string, unknown>]> = [
      ['a value that is not JSON', { value: '{not json' }],
      ['no change id', { change_id: '' }],
      ['an unknown kind', { kind: 'delete_everything' }],
      ['an unknown entity', { entity: 'users' }],
      ['an author name no copy records', { author_name: 'Darryl\u0000' }],
      ['a base that is no list of change ids', { base: '{"a":1}' }],
      ['a sequence that is no whole number', { replica_seq: 1.5 }],
      ["another project's change", { project_id: 'p-other' }],
    ];
    for (const [what, fields] of broken) {
      const refused = await apply(hosted.referee, [{ ...first, ...fields }, ...rest], d);
      expect({ what, code: refused.error?.code }).toEqual({
        what,
        code: REFEREE_ERROR_CODES.MALFORMED,
      });
    }
    expect((await apply(hosted.referee, 'not a list', d)).error?.code).toBe(
      REFEREE_ERROR_CODES.MALFORMED
    );
    expect(count(hosted.referee)).toBe(before);
    // The whole delivery, sent well formed, is taken in: each of its changes, and a verdict on each transaction.
    const taken = await apply(hosted.referee, changes, d);
    expect(taken.error).toBeUndefined();
    expect(count(hosted.referee, `replica_id = '${d.replicaId}'`)).toBe(changes.length);
    expect(count(hosted.referee)).toBe(
      before + changes.length + (taken.data as { judged: number }).judged
    );
  }, 180000);

  it('refuses a newer protocol at the exchange and at intake, kept on its copy and never given a refused verdict', async () => {
    const { hosted, darryl, d, changes } = await darrylWrote();
    const said = await ask(hosted.referee, (location) =>
      peer(location, 'hello', { recordProtocol: PROTOCOL_VERSION + 1 }, d)
    );
    expect(said.error).toMatchObject({
      code: REFEREE_ERROR_CODES.PROTOCOL_NEWER,
      suggestion: expect.stringMatching(/stay safe on your copy/),
    });
    const newer = changes.map((change, index) =>
      index === changes.length - 1 ? { ...change, protocol_version: PROTOCOL_VERSION + 1 } : change
    );
    const before = count(hosted.referee);
    const verdicts = count(hosted.referee, "kind = 'verdict'");
    const refused = await apply(hosted.referee, newer, d);
    expect(refused.error?.code).toBe(REFEREE_ERROR_CODES.PROTOCOL_NEWER);
    expect(count(hosted.referee)).toBe(before);
    expect(count(hosted.referee, "kind = 'verdict'")).toBe(verdicts);
    // A newer protocol may bring kinds this version does not know: still newer, never malformed.
    const unknownKind = changes.map((change, index) =>
      index === 0 ? { ...change, kind: 'reshape', protocol_version: PROTOCOL_VERSION + 1 } : change
    );
    expect((await apply(hosted.referee, unknownKind, d)).error?.code).toBe(
      REFEREE_ERROR_CODES.PROTOCOL_NEWER
    );
    // The copy keeps what it wrote: nothing on it was touched.
    expect((await pendingOf(darryl, hosted.referee)).map((change) => change.change_id)).toEqual(
      changes.map((change) => change.change_id)
    );
  }, 180000);

  it('takes a renumber only at the block it admitted for its replica (fact 34)', async () => {
    const { hosted, darryl, d, changes } = await darrylWrote();
    expect((await apply(hosted.referee, changes, d)).error).toBeUndefined();
    // A same-identity move to a fresh block is the later holder's way out of a clash; with none, it is refused.
    expect(
      (
        await ask(hosted.referee, (location) =>
          peer(location, 'admitSuccessor', { replicaId: d.replicaId, sameId: true }, d)
        )
      ).error?.code
    ).toBe(REFEREE_ERROR_CODES.METHOD_REFUSED);
    // A real renumber: Darryl's machine is restored, store and registry together, and writes again
    // into a slot the referee holds. His next sync gives him a successor, which renumbers his create.
    const restore = await backUp(fixture.tmp, darryl, { machine: true });
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Written before the restore.',
    });
    await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
    restore();
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'Written again after it.' });
    // The forged form of the renumber his sync is about to send is refused first.
    let forgedRenumber: LoggedChange | undefined;
    const peerOf = refereePeer(fixture.tmp, hosted.referee, darryl, 'acct-darryl');
    const watching = {
      ...peerOf,
      apply: async (
        sent: readonly LoggedChange[],
        options?: { judge?: boolean; catchUp?: boolean }
      ) => {
        const renumber = sent.find((change) => change.kind === 'renumber');
        if (renumber && !forgedRenumber) {
          forgedRenumber = {
            ...renumber,
            value: JSON.stringify({ ...JSON.parse(renumber.value!), block: 999_999 }),
          };
          const caller = await callerOf(fixture.tmp, darryl, 'acct-darryl');
          const before = count(hosted.referee);
          const forged = sent.map((change) => (change === renumber ? forgedRenumber! : change));
          expect((await apply(hosted.referee, forged, caller)).error?.code).toBe(
            REFEREE_ERROR_CODES.FORGED_RENUMBER
          );
          // A renumber moves only numbered rows: one naming a mission is refused.
          const otherTable = sent.map((change) =>
            change === renumber
              ? {
                  ...change,
                  value: JSON.stringify({
                    ...JSON.parse(change.value!),
                    rows: [
                      {
                        entity: 'missions',
                        entityId: 'x',
                        id: JSON.parse(change.value!).block * 1_000_000 + 1,
                      },
                    ],
                  }),
                }
              : change
          );
          expect((await apply(hosted.referee, otherTable, caller)).error?.code).toBe(
            REFEREE_ERROR_CODES.FORGED_RENUMBER
          );
          // The same block named twice reads two ways, so it is refused before it is read at all.
          const twice = sent.map((change) =>
            change === renumber
              ? {
                  ...change,
                  value: change.value!.replace('{"block":', '{"block":9000000000000,"block":'),
                }
              : change
          );
          expect((await apply(hosted.referee, twice, caller)).error?.code).toBe(
            REFEREE_ERROR_CODES.MALFORMED
          );
          expect(count(hosted.referee)).toBe(before);
        }
        return peerOf.apply(sent, options);
      },
    };
    const report = await exchange(copyPeer(fixture.tmp, darryl), watching);
    expect(report.error).toBeUndefined();
    expect(report.data!.reidentified).toMatchObject({ reason: 'slot' });
    expect(forgedRenumber).toBeDefined();
    expect(count(hosted.referee, "kind = 'renumber'")).toBe(1);
    expect(
      onReferee<{ block: number }>(
        hosted.referee,
        "SELECT json_extract(value, '$.block') AS block FROM record_changes WHERE kind = 'renumber'"
      )
    ).toEqual([{ block: report.data!.reidentified!.block }]);
    void mint;
  }, 240000);
});
