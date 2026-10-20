// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s100-m01 (the build's critics, round 1): a newer record protocol on every path that takes changes in: a recovery
// ABOUTME: and a join refuse it, a bundle holds it across the bundle, a held move asks no one to confirm, and the review says it.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { monotonicFactory } from 'ulid';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { exchangeText } from '../../../src/cli/sync-moves';
import { replicaMarks } from '../../../src/tools/rbook/record-apply';
import { importBundle, writeBundle } from '../../../src/tools/rbook/record-bundle';
import { exchange } from '../../../src/tools/rbook/record-exchange';
import { requestJoin } from '../../../src/tools/rbook/record-join';
import { judge } from '../../../src/tools/rbook/record-judge';
import { handOver } from '../../../src/tools/rbook/record-moves';
import {
  PROTOCOL_VERSION,
  upgradeRecordProtocolForTesting,
} from '../../../src/tools/rbook/record-protocol';
import { recoverAuthority } from '../../../src/tools/rbook/record-recovery';
import { sharedRecordReview } from '../../../src/tools/rbook/record-review';
import { sharedRecordText } from '../../../src/tools/rbook/digest-v2';
import { mergeContext } from '../../../src/tools/rbook/record-standing';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import {
  copyPeer,
  joinedCopy,
  onCopy,
  ownerCopy,
  read,
  syncCopies,
  type Copy,
} from '../../helpers/shared-copies';
import { NEWER, writeAsNewerRelease } from '../../helpers/newer-protocol';

const mint = monotonicFactory();
let fixture: ReplicaFixture;
let undo: (() => void) | null = null;
beforeEach(() => {
  fixture = replicaFixture('rbook-protocol-paths-');
});
afterEach(() => {
  undo?.();
  undo = null;
  fixture.restore();
});

async function decide(copy: Copy, content: string) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call('rbook_decisions', {
    action: 'record',
    content,
    projectRoot: copy.root,
  });
  if (!answer.success) throw new Error(`${copy.name}: ${JSON.stringify(answer.error)}`);
}

const unchecked = <T>(copy: Copy, use: Parameters<typeof onCopy<T>>[2]) =>
  onCopy(fixture.tmp, copy, use, { replicaCheck: false });

/** A decision `copy` records while this process speaks the newer protocol: a known kind, written newer. */
async function decideNewer(copy: Copy, content: string): Promise<void> {
  const back = upgradeRecordProtocolForTesting(NEWER);
  try {
    await decide(copy, content);
  } finally {
    back();
  }
}

/** A carried file of a copy's store, on another machine, as a person carries one. */
function carry(from: Copy, name: string, machine: string, author: string): Copy {
  const root = path.join(fixture.tmp, name);
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  const source = new Database(dbOf(from.root));
  try {
    source.exec(`VACUUM INTO '${dbOf(root).replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  useMachine(fixture.tmp, machine);
  writeUserAuthor(author);
  return { name, root, machine, replicaId: from.replicaId, block: from.block };
}

const live = (copy: Copy, text: string): number =>
  read<{ n: number }>(
    copy,
    'SELECT count(*) AS n FROM strategic_decisions WHERE decision_text LIKE ?',
    [`${text}%`]
  )[0].n;

describe('every path that takes changes in (s100-m01, critics round 1)', () => {
  it('a recovery stops before taking in a member copy that holds newer changes, which its cut would lose', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const pat = await joinedCopy(fixture.tmp, owner, 'pat', 'Pat');
    await syncCopies(fixture.tmp, studio, owner);
    await syncCopies(fixture.tmp, pat, owner);
    // The owner upgraded first and wrote in the newer protocol; pat, upgraded too, took it in.
    await decideNewer(owner, 'Owner, in the newer protocol.');
    undo = upgradeRecordProtocolForTesting(NEWER);
    await syncCopies(fixture.tmp, pat, owner);
    undo();
    undo = null;
    // The owner's machine is lost; a copy of the studio's, still on this version, recovers it.
    const recovered = carry(studio, 'recovered', 'machine-new', 'Owner');
    const epochBefore = await unchecked(recovered, (client) => mergeContext(client).epoch);
    useMachine(fixture.tmp, recovered.machine);
    const report = await recoverAuthority(
      (step) => onCopy(fixture.tmp, recovered, step, { replicaCheck: false }),
      [studio, pat].map((peer) => copyPeer(fixture.tmp, peer)),
      { members: ['Darryl', 'Pat'] }
    );
    expect(report.success).toBe(false);
    expect(report.error?.message).toMatch(new RegExp(`record protocol ${NEWER}, newer than`));
    expect(report.error?.suggestion).toMatch(/Upgrade Reasonbook here.*run the recovery again/);
    // Nothing was recorded as the owner copy: pat's change still counts where it did.
    expect(await unchecked(recovered, (client) => mergeContext(client).epoch)).toBe(epochBefore);
    expect(live(pat, 'Owner, in the newer protocol.')).toBe(1);
  }, 600000);

  it("a recovery on a carried copy of a newer member's store stops before it changes anything", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const pat = await joinedCopy(fixture.tmp, owner, 'pat', 'Pat');
    await syncCopies(fixture.tmp, pat, owner);
    // pat upgraded and wrote in the newer protocol; the owner's machine is then lost.
    await decideNewer(pat, 'Pat, in the newer protocol.');
    // pat's store is carried to a machine on this version, which recovers the owner's copy.
    const recovered = carry(pat, 'recovered', 'machine-new', 'Owner');
    const identity = () =>
      unchecked(recovered, (client) => ({
        replica: mergeContext(client).ownReplica,
        epoch: mergeContext(client).epoch,
      }));
    const before = await identity();
    useMachine(fixture.tmp, recovered.machine);
    const report = await recoverAuthority(
      (step) => onCopy(fixture.tmp, recovered, step, { replicaCheck: false }),
      [copyPeer(fixture.tmp, pat)],
      { members: ['Pat'] }
    );
    expect(report.success).toBe(false);
    expect(report.error?.message).toMatch(/^This copy holds changes written in record protocol/);
    expect(await identity()).toEqual(before);
  }, 600000);

  it('a joined copy keeps none of the notes its carried store brought', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const darryl = await joinedCopy(fixture.tmp, owner, 'darryl');
    await syncCopies(fixture.tmp, darryl, owner);
    writeAsNewerRelease(dbOf(darryl.root));
    await syncCopies(fixture.tmp, darryl, owner);
    // The owner's store now notes the newer protocol it kept out, and a copy of it carries the note.
    expect((await unchecked(owner, (client) => sharedRecordReview(client)))?.upgrade).toMatch(
      /record protocol/
    );
    const erin = await joinedCopy(fixture.tmp, owner, 'erin', 'Erin');
    const review = await unchecked(erin, (client) => sharedRecordReview(client));
    expect(review?.upgrade).toBeUndefined();
  }, 600000);

  it("a join refuses a carried copy of a newer owner copy's store, naming the upgrade", async () => {
    const owner = await ownerCopy(fixture.tmp);
    await decideNewer(owner, 'Owner, in the newer protocol.');
    const newbie = carry(owner, 'newbie', 'machine-newbie', 'Newbie');
    const asked = await unchecked(newbie, (client) => requestJoin(client));
    expect(asked.success).toBe(false);
    expect(asked.error?.message).toMatch(new RegExp(`record protocol ${NEWER}, newer than`));
    expect(asked.error?.suggestion).toMatch(/Upgrade Reasonbook on this machine/);
  }, 600000);

  it('a bundle keeps out a newer change and the rest of its stream, says so, and the review keeps saying it', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const darryl = await joinedCopy(fixture.tmp, owner, 'darryl');
    await syncCopies(fixture.tmp, darryl, owner);
    await decide(darryl, 'Before the bump.');
    const bump = writeAsNewerRelease(dbOf(darryl.root));
    await decide(darryl, 'After the bump.');
    const marks = await unchecked(owner, (client) => replicaMarks(client));
    const bundle = await unchecked(darryl, (client) => writeBundle(client, marks));
    const imported = await unchecked(owner, (client) => importBundle(client, bundle));
    expect(imported.success).toBe(true);
    expect(imported.data?.newerProtocol).toBeGreaterThan(0);
    expect((imported.warnings ?? []).join(' ')).toMatch(/Upgrade Reasonbook here/);
    // Nothing from the newer change on is stored or judged.
    expect(live(owner, 'Before the bump.')).toBe(1);
    expect(live(owner, 'After the bump.')).toBe(0);
    expect(
      read<{ n: number }>(
        owner,
        'SELECT count(*) AS n FROM record_changes WHERE replica_id = ? AND replica_seq >= ?',
        [darryl.replicaId, bump.seq]
      )[0].n
    ).toBe(0);
    // The owner copy, which has to upgrade, is told by its review, which no sync's answer replaces,
    // and by the digest, under this copy's own heading.
    const review = await unchecked(owner, (client) => sharedRecordReview(client));
    expect(review?.upgrade).toMatch(new RegExp(`record protocol ${NEWER}`));
    expect(sharedRecordText(review)).toMatch(/• This copy: this copy keeps out changes/);
    // Upgraded, the review no longer says it.
    undo = upgradeRecordProtocolForTesting(NEWER);
    const after = await unchecked(owner, (client) => sharedRecordReview(client));
    expect(JSON.stringify(after)).not.toMatch(new RegExp(`record protocol ${NEWER}`));
  }, 600000);

  it('the warning names the copy that kept changes out, whichever copy ran the sync', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const darryl = await joinedCopy(fixture.tmp, owner, 'darryl');
    await syncCopies(fixture.tmp, darryl, owner);
    writeAsNewerRelease(dbOf(darryl.root));
    // darryl, the newer copy, runs it: the owner's copy kept its change out, not darryl's.
    const fromDarryl = await exchange(copyPeer(fixture.tmp, darryl), copyPeer(fixture.tmp, owner));
    expect(fromDarryl.success).toBe(true);
    const said = (fromDarryl.warnings ?? []).join(' ');
    expect(said).toMatch(/^owner kept out \d+ change\(s\) this copy sent/);
    expect(said).not.toMatch(/Upgrade Reasonbook here/);
    // The owner runs it: this copy kept them out, and this copy upgrades.
    const fromOwner = await exchange(copyPeer(fixture.tmp, owner), copyPeer(fixture.tmp, darryl));
    expect((fromOwner.warnings ?? []).join(' ')).toMatch(/Upgrade Reasonbook here/);
  }, 600000);

  it('a move kept out for its newer protocol asks no one to confirm it', async () => {
    const old = await ownerCopy(fixture.tmp);
    const next = await joinedCopy(fixture.tmp, old, 'next', 'Owner');
    await syncCopies(fixture.tmp, old, next);
    // The old owner copy upgraded first, so the move it writes is in the newer protocol.
    undo = upgradeRecordProtocolForTesting(NEWER);
    expect(
      (await unchecked(old, (client) => handOver(client, { to: next.replicaId }))).success
    ).toBe(true);
    undo();
    undo = null;
    const result = await exchange(copyPeer(fixture.tmp, old), copyPeer(fixture.tmp, next));
    expect(result.success).toBe(true);
    expect(result.data?.caughtUp).toBeUndefined();
    expect(exchangeText(result.data!)).not.toMatch(/confirm/);
    expect((result.warnings ?? []).join(' ')).toMatch(/kept out/);
    expect(await unchecked(next, (client) => mergeContext(client).pending)).toBeNull();
  }, 600000);

  it("keeps out a newer change whose author name this version's rule would refuse, and keeps exchanging", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const darryl = await joinedCopy(fixture.tmp, owner, 'darryl');
    await syncCopies(fixture.tmp, darryl, owner);
    // A later release's longer author name, on a change of a kind this version knows.
    const db = new Database(dbOf(darryl.root));
    const meta = (key: string) =>
      (db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string }).value;
    const seq = Number(meta('replica_seq')) + 1;
    const hlc = `${String(Date.now() + 1000).padStart(13, '0')}-000000`;
    db.prepare("UPDATE metadata SET value = ? WHERE key = 'replica_seq'").run(String(seq));
    db.prepare("UPDATE metadata SET value = ? WHERE key = 'replica_hlc'").run(hlc);
    db.prepare(
      `INSERT INTO record_changes (change_id, txn_id, project_id, replica_id, replica_seq, author_name, author_user_id, hlc, protocol_version, kind, entity, entity_id, field, value, base)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'set', 'replica', ?, 'note', '"x"', NULL)`
    ).run(
      mint(),
      mint(),
      meta('project_id'),
      meta('replica_id'),
      seq,
      'd'.repeat(81),
      hlc,
      NEWER,
      meta('replica_id')
    );
    db.close();
    const said = await exchange(copyPeer(fixture.tmp, darryl), copyPeer(fixture.tmp, owner));
    expect(said.error).toBeUndefined();
    expect(said.success).toBe(true);
  }, 600000);

  it('judges no verdict on a newer transaction an older release stored, so it waits for the upgrade', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const darryl = await joinedCopy(fixture.tmp, owner, 'darryl');
    await syncCopies(fixture.tmp, darryl, owner);
    // An older release stored darryl's newer change verbatim, before copies held them out.
    await decideNewer(darryl, 'Darryl, in the newer protocol.');
    const [txn] = read<{ txn_id: string }>(
      darryl,
      "SELECT txn_id FROM record_changes WHERE kind = 'create' AND value LIKE '%Darryl, in the newer protocol.%'"
    );
    const changes = read<Record<string, unknown>>(
      darryl,
      'SELECT * FROM record_changes WHERE txn_id = ?',
      [txn.txn_id]
    );
    const db = new Database(dbOf(owner.root));
    for (const change of changes) {
      const columns = Object.keys(change);
      db.prepare(
        `INSERT INTO record_changes (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      ).run(...columns.map((column) => change[column]));
    }
    db.close();
    const verdict = await unchecked(owner, (client) =>
      judge(client, mergeContext(client), txn.txn_id)
    );
    expect(verdict.verdict).toBeNull();
    expect(verdict.reason).toMatch(
      new RegExp(`record protocol ${NEWER}, newer than this copy's ${PROTOCOL_VERSION}`)
    );
  }, 600000);
});
