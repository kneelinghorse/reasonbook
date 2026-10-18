// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m13 (ADR s96 §7) — one exchange between a member's copy and the owner's leaves both with the same
// ABOUTME: record, and stops before anything moves when the copies cannot be in one star or a chain or block clashes.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { admitMember } from '../../../src/tools/rbook/record-apply';
import { chainHash } from '../../../src/tools/rbook/record-chain';
import { recordedExecute } from '../../../src/tools/rbook/record-changes';
import { RECORD_COLUMNS, RECORDED_TABLES } from '../../../src/tools/rbook/record-columns';
import {
  clientPeer,
  exchange,
  SYNC_PROTOCOL,
  type Peer,
} from '../../../src/tools/rbook/record-exchange';
import { seedRbookDb } from '../../helpers/seedRbookDb';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  withClient,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { memberCopy, onCopy, ownerCopy, read, type Copy } from '../../helpers/shared-copies';
import { sharedRecordReview } from '../../../src/tools/rbook/record-review';
import { shareRecord } from '../../../src/tools/rbook/record-share';
import { prepareForSharing } from '../../../src/tools/rbook/sharing-preconditions';
import { writeUserAuthor } from '../../../src/intelligence/user-author';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-exchange-');
});
afterEach(() => fixture.restore());

async function ok(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

/** A copy this process opens, on its own machine, as the far end of an exchange would be. */
const peerOf = (copy: Copy, options: { replicaCheck?: boolean } = {}): Peer =>
  clientPeer(copy.name, (step) => onCopy(fixture.tmp, copy, step, options));

async function sync(member: Copy, owner: Copy) {
  const result = await exchange(peerOf(member), peerOf(owner));
  if (!result.success) throw new Error(`${member.name}: ${JSON.stringify(result.error)}`);
  return result.data!;
}

/** Every recorded column of every shared table, and the open conflicts: what two copies must agree on. */
function recorded(copy: Copy): Record<string, unknown> {
  const state: Record<string, unknown> = {
    conflicts: read(copy, 'SELECT entity, entity_id, field FROM record_conflicts ORDER BY 1, 2, 3'),
  };
  for (const table of RECORDED_TABLES) {
    const columns = RECORD_COLUMNS[table].recorded.map((column) => `"${column}"`).join(', ');
    state[table] = read(copy, `SELECT ${columns} FROM ${table} ORDER BY ${columns}`);
  }
  return state;
}

describe('an exchange between a member and the owner', () => {
  it('offline writes on both copies, then one exchange, leave the record equal and a conflict on both', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const id = (await ok(owner, 'rbook_decisions', { action: 'record', content: 'Contested.' }))
      .data!.decisionId!;
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await sync(member, owner);
    // Each copy works on its own, and both change one decision's status without seeing the other.
    await ok(owner, 'rbook_decisions', { action: 'record', content: 'The owner decides offline.' });
    await ok(member, 'rbook_decisions', {
      action: 'record',
      content: 'The member decides offline.',
    });
    await ok(owner, 'rbook_decisions', { action: 'update', decisionId: id, status: 'archived' });
    await ok(member, 'rbook_decisions', { action: 'update', decisionId: id, status: 'stale' });
    const report = await sync(member, owner);
    expect(report.sent).toBeGreaterThan(0);
    expect(report.received).toBeGreaterThan(0);
    expect(recorded(member)).toEqual(recorded(owner));
    for (const copy of [owner, member])
      expect(read(copy, 'SELECT entity, field FROM record_conflicts')).toEqual([
        { entity: 'strategic_decisions', field: 'status' },
      ]);
    expect(report.digest.hash).toMatch(/^[0-9a-f]{64}$/);
  }, 120000);

  it('a second exchange with nothing new moves nothing', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await ok(member, 'rbook_decisions', { action: 'record', content: 'Once.' });
    await sync(member, owner);
    const again = await sync(member, owner);
    expect({ sent: again.sent, received: again.received }).toEqual({ sent: 0, received: 0 });
  }, 120000);

  it("a member's refused write is recomputed away and listed, and a dependent of it does not hold back later work", async () => {
    const owner = await ownerCopy(fixture.tmp);
    // Not admitted yet: the owner refuses what it writes now, and sends a copy that is no member nothing.
    const member = await memberCopy(fixture.tmp, owner, 'member', 1, { admit: false });
    await ok(member, 'rbook_mission', { action: 'add', missionId: 'x-m01', name: 'Refused' });
    expect(await sync(member, owner)).toMatchObject({ removed: true, received: 0 });
    expect(read(member, "SELECT id FROM missions WHERE id = 'x-m01'")).toEqual([{ id: 'x-m01' }]);
    // Admitted now: its note on the refused mission is refused by the cascade, and both come back.
    await onCopy(fixture.tmp, owner, (client) => {
      const admitted = admitMember(client, {
        replicaId: member.replicaId,
        block: 1,
        role: 'editor',
      });
      if (!admitted.success) throw new Error(admitted.error?.message);
    });
    await ok(member, 'rbook_mission', {
      action: 'update',
      missionId: 'x-m01',
      fields: { notes: 'A note on the refused mission.' },
    });
    await sync(member, owner);
    expect(read(member, "SELECT id FROM missions WHERE id = 'x-m01'")).toEqual([]);
    expect(
      read<{ state: string }>(member, 'SELECT state FROM record_txn_state').map((row) => row.state)
    ).toEqual(['refused', 'refused']);
    const review = await onCopy(fixture.tmp, member, (client) => sharedRecordReview(client));
    expect(review?.waiting.join(' ')).toMatch(/2 refused by the owner's copy/);
    // Its next write goes live on both copies, whatever its refused work left.
    await ok(member, 'rbook_mission', { action: 'add', missionId: 'x-m02', name: 'Accepted' });
    await sync(member, owner);
    for (const copy of [owner, member])
      expect(read(copy, "SELECT id FROM missions WHERE id LIKE 'x-m%' ORDER BY id")).toEqual([
        { id: 'x-m02' },
      ]);
  }, 120000);
});

describe('an exchange that stops before anything moves', () => {
  it("two members cannot exchange: a member syncs only with the owner's copy", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const a = await memberCopy(fixture.tmp, owner, 'a', 1);
    const b = await memberCopy(fixture.tmp, owner, 'b', 2);
    const refused = await exchange(peerOf(a), peerOf(b));
    expect(refused.error).toMatchObject({
      code: 'RECORD_EXCHANGE_REFUSED',
      suggestion: "Sync with the owner's copy.",
    });
  }, 120000);

  it("another project's copy is refused", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const otherRoot = path.join(fixture.tmp, 'other');
    seedRbookDb(otherRoot, { projectId: 'p-other', projectName: 'other' });
    useMachine(fixture.tmp, 'machine-other');
    writeUserAuthor('Other');
    const otherId = await onCopy(
      fixture.tmp,
      { root: otherRoot, machine: 'machine-other' },
      (client) => {
        if (!prepareForSharing(client).ready) throw new Error('not ready');
        return shareRecord(client).replicaId;
      },
      { replicaCheck: false }
    );
    const other: Copy = {
      name: 'other',
      root: otherRoot,
      machine: 'machine-other',
      replicaId: otherId,
      block: 0,
    };
    const refused = await exchange(peerOf(other), peerOf(owner));
    expect(refused.error).toMatchObject({
      code: 'RECORD_EXCHANGE_REFUSED',
      message: expect.stringMatching(/holds project p-shared and this copy holds project p-other/),
    });
  }, 120000);

  it('a copy that speaks another sync protocol is refused, and nothing moves', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await ok(member, 'rbook_decisions', { action: 'record', content: 'Stays here.' });
    const real = peerOf(owner);
    const newer: Peer = {
      ...real,
      hello: async () => ({ ...(await real.hello()), protocol: SYNC_PROTOCOL + 1 }),
    };
    const refused = await exchange(peerOf(member), newer);
    expect(refused.error).toMatchObject({ code: 'RECORD_EXCHANGE_REFUSED' });
    expect(
      read(
        owner,
        "SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = 'Stays here.'"
      )
    ).toEqual([{ n: 0 }]);
  }, 120000);
});

describe('the hash chain (s96-m13 build-time critics)', () => {
  it('leaves out the user id a copy may stamp, and covers every field the author wrote', async () => {
    const owner = await ownerCopy(fixture.tmp);
    await ok(owner, 'rbook_decisions', { action: 'record', content: 'Hashed.' });
    const twin = path.join(fixture.tmp, 'twin');
    fs.mkdirSync(path.dirname(dbOf(twin)), { recursive: true });
    const source = new Database(dbOf(owner.root));
    try {
      source.exec(`VACUUM INTO '${dbOf(twin).replace(/'/g, "''")}'`);
    } finally {
      source.close();
    }
    /** Edit the twin's log outside its guards, as only a test does. */
    const edit = (sql: string) => {
      const db = new Database(dbOf(twin));
      try {
        for (const { name } of db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'record_changes'"
          )
          .all() as Array<{ name: string }>)
          db.exec(`DROP TRIGGER "${name}"`);
        db.exec(sql);
      } finally {
        db.close();
      }
    };
    const [{ seq }] = read<{ seq: number }>(
      owner,
      'SELECT max(replica_seq) AS seq FROM record_changes WHERE replica_id = ?',
      [owner.replicaId]
    );
    const hashOf = (root: string) =>
      withClient(root, (client) => chainHash(client, owner.replicaId, seq), {
        replicaCheck: false,
      });
    const original = await hashOf(owner.root);
    // ADR s96 §10: the user id stays out of the chain, so a copy that stamps one keeps its chain.
    edit("UPDATE record_changes SET author_user_id = 'someone-elsewhere'");
    expect(await hashOf(twin)).toBe(original);
    edit(`UPDATE record_changes SET author_name = 'Mallory' WHERE replica_seq = ${seq}`);
    expect(await hashOf(twin)).not.toBe(original);
  }, 120000);
});
