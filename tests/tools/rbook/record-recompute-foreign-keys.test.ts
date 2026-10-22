// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Alias renames preserve real referenced rows within recompute's encompassing transaction.
// ABOUTME: Deferred checks stay enabled through COMMIT, reject invalid graphs and reset after rollback.
import Database from 'better-sqlite3';
import type { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { genesisColumns, getProjectId } from '../../../src/tools/rbook/genesis-columns';
import { applyRemote, changesSince } from '../../../src/tools/rbook/record-apply';
import { recordedWrite } from '../../../src/tools/rbook/record-changes';
import { decideTransactions } from '../../../src/tools/rbook/record-decide';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import { recomputeEntities } from '../../../src/tools/rbook/record-recompute';
import { mergeContext, type LoggedChange } from '../../../src/tools/rbook/record-standing';
import { underApplyToken } from '../../../src/tools/rbook/record-token';
import { dbOf, replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, read, type Copy } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
let restoreProtocol: () => void;
beforeEach(() => {
  fixture = replicaFixture('rbook-recompute-fk-');
  // Pre-switch claims retain the clock ordering that can rename an existing materialized row.
  restoreProtocol = upgradeRecordProtocolForTesting(1);
});
afterEach(() => {
  restoreProtocol();
  fixture.restore();
});

type Parent = 'sessions' | 'missions' | 'sprints';
const fields = (table: Parent, id: string) => {
  const named = { id, title: 'A referenced claim' };
  if (table === 'sprints') return named;
  if (table === 'missions') return { id, name: named.title, status: 'Queued' };
  return { ...named, type: 'planning', started_at: new Date().toISOString(), status: 'completed' };
};
const reference = { sessions: 'author_session_id', missions: 'mission_id', sprints: 'sprint_id' };

function insert(
  client: RbookDatabaseClient,
  table: Parent | 'strategic_decisions',
  values: Record<string, unknown>
) {
  const written = recordedWrite(client, () => {
    const stamp = genesisColumns(client, table, getProjectId(client));
    const names = [...Object.keys(values), ...stamp.columns];
    return client.execute(
      `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      [...Object.values(values), ...stamp.values]
    );
  });
  if (!written.success) throw new Error(JSON.stringify(written.error));
}

async function collision(table: Parent) {
  const owner = await ownerCopy(fixture.tmp);
  const member = await joinedCopy(fixture.tmp, owner, 'member');
  const id = 'referenced-claim';
  await onCopy(fixture.tmp, owner, (client) => {
    insert(client, table, fields(table, id));
    insert(client, 'strategic_decisions', {
      decision_text: 'This decision must keep its original parent after the rename.',
      created_at: new Date().toISOString(),
      [reference[table]]: id,
    });
  });
  const [parent] = read<{ stable_event_id: string }>(
    owner,
    `SELECT stable_event_id FROM ${table} WHERE id = ?`,
    [id]
  );
  await onCopy(fixture.tmp, member, (client) => insert(client, table, fields(table, id)));
  const [claim] = read<LoggedChange>(
    member,
    "SELECT * FROM record_changes WHERE entity = ? AND kind = 'create' AND replica_id = ?",
    [table, member.replicaId]
  );
  // Clock skew is a supported pre-S input. Do not mutate the semantic fields or arrival sequence.
  const db = new Database(dbOf(member.root));
  try {
    db.prepare('UPDATE record_changes SET hlc = ? WHERE txn_id = ?').run(
      `${String(Date.now() - 60_000).padStart(13, '0')}-000000`,
      claim.txn_id
    );
  } finally {
    db.close();
  }
  const incoming = await onCopy(fixture.tmp, member, (client) => changesSince(client, {}));
  const applied = await onCopy(fixture.tmp, owner, (client) =>
    applyRemote(client, incoming, { judge: false })
  );
  expect(applied.success).toBe(true);
  expect(
    read(owner, `SELECT id FROM ${table} WHERE stable_event_id = ?`, [parent.stable_event_id])
  ).toEqual([{ id }]);
  return { owner, id, parent: parent.stable_event_id, claim };
}

function graph(copy: Copy) {
  return {
    changes: read(copy, 'SELECT * FROM record_changes ORDER BY change_id'),
    standing: read(copy, 'SELECT * FROM record_txn_state ORDER BY txn_id'),
    sessions: read(copy, 'SELECT * FROM sessions ORDER BY id'),
    missions: read(copy, 'SELECT * FROM missions ORDER BY id'),
    sprints: read(copy, 'SELECT * FROM sprints ORDER BY id'),
    decisions: read(copy, 'SELECT * FROM strategic_decisions ORDER BY id'),
    aliases: read(copy, 'SELECT * FROM record_aliases ORDER BY entity, renamed_id'),
    heads: read(copy, 'SELECT * FROM record_heads ORDER BY entity, entity_id, field, change_id'),
  };
}

it.each<Parent>(['sessions', 'missions', 'sprints'])(
  'accepts a colliding %s claim without detaching its existing real FK child',
  async (table) => {
    const { owner, id, parent, claim } = await collision(table);
    await onCopy(fixture.tmp, owner, (client) => {
      expect(client.pragma('foreign_keys')).toEqual([{ foreign_keys: 1 }]);
      expect(client.pragma('defer_foreign_keys')).toEqual([{ defer_foreign_keys: 0 }]);
      const accepted = decideTransactions(client, [claim.txn_id], 'accepted', 'Reviewed claim.');
      expect(accepted.error).toBeUndefined();
      expect(accepted).toMatchObject({ success: true, data: 1 });
      expect(client.pragma('foreign_keys')).toEqual([{ foreign_keys: 1 }]);
      expect(client.pragma('defer_foreign_keys')).toEqual([{ defer_foreign_keys: 0 }]);
      expect(client.pragma('foreign_key_check')).toEqual([]);
    });
    const renamed = `${id}~${owner.block}`;
    expect(read(owner, `SELECT id FROM ${table} WHERE stable_event_id = ?`, [parent])).toEqual([
      { id: renamed },
    ]);
    expect(read(owner, `SELECT ${reference[table]} AS parent FROM strategic_decisions`)).toEqual([
      { parent: renamed },
    ]);
    expect(
      read(owner, `SELECT id FROM ${table} WHERE stable_event_id = ?`, [claim.entity_id])
    ).toEqual([{ id }]);
  }
);

it('rolls back the accepted verdict, rename and every row when the final graph still has an invalid FK', async () => {
  const { owner, claim } = await collision('sessions');
  const before = graph(owner);
  await onCopy(fixture.tmp, owner, (client) => {
    let inserted = false;
    let returnedFromWork = false;
    const outer = client.writeTransaction(() => {
      const accepted = decideTransactions(client, [claim.txn_id], 'accepted', 'Reviewed claim.');
      expect(accepted.success).toBe(true);
      expect(client.pragma('defer_foreign_keys')).toEqual([{ defer_foreign_keys: 1 }]);
      expect(client.pragma('foreign_keys')).toEqual([{ foreign_keys: 1 }]);
      underApplyToken(client, () => {
        const bad = client.execute(
          "INSERT INTO session_missions (session_id, mission_id, linked_at) VALUES ('absent-session', 'absent-mission', ?)",
          [new Date().toISOString()]
        );
        if (!bad.success) throw new Error(JSON.stringify(bad.error));
        inserted = true;
      });
      returnedFromWork = true;
    });
    expect(inserted).toBe(true);
    expect(returnedFromWork).toBe(true); // The refusal must happen at COMMIT, not the injected INSERT.
    expect(outer.success).toBe(false);
    expect(outer.error?.message).toMatch(/foreign key/i);
    expect(client.pragma('foreign_keys')).toEqual([{ foreign_keys: 1 }]);
    expect(client.pragma('defer_foreign_keys')).toEqual([{ defer_foreign_keys: 0 }]);
    expect(client.pragma('foreign_key_check')).toEqual([]);
    expect(client.inTransaction).toBe(false);
  });
  expect(graph(owner)).toEqual(before);
  expect(read(owner, 'SELECT * FROM session_missions')).toEqual([]);
  // A later valid transaction still succeeds after the deferred COMMIT failure.
  expect(
    await onCopy(fixture.tmp, owner, (client) =>
      decideTransactions(client, [claim.txn_id], 'accepted', 'Reviewed after correcting the graph.')
    )
  ).toMatchObject({ success: true, data: 1 });
});

it('refuses recompute without an encompassing transaction before changing connection state', async () => {
  const owner = await ownerCopy(fixture.tmp);
  await onCopy(fixture.tmp, owner, (client) => {
    expect(() => recomputeEntities(client, mergeContext(client), new Set(), new Set())).toThrow(
      /transaction/i
    );
    expect(client.pragma('defer_foreign_keys')).toEqual([{ defer_foreign_keys: 0 }]);
    expect(client.pragma('foreign_keys')).toEqual([{ foreign_keys: 1 }]);
  });
});
