// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Writable upgrade retries only stored transactions an older protocol could not judge.
// ABOUTME: Read-only opens preserve history, other refusals remain final, and failed replay rolls back.
import Database from 'better-sqlite3';
import { RbookDatabaseClient, withClient, withClientAsync } from '../../../src/tools/rbook/client';
import { createError, createSuccess } from '../../../src/tools/rbook/errors';
import * as derived from '../../../src/tools/rbook/record-derived';
import { applyRemote, changesSince } from '../../../src/tools/rbook/record-apply';
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import { confirmOwner, handOver } from '../../../src/tools/rbook/record-moves';
import { countedVerdicts } from '../../../src/tools/rbook/record-positions';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import { mergeContext } from '../../../src/tools/rbook/record-standing';
import { captureToolCall } from '../../../src/tools/rbook/tool-call-context';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, read, type Copy } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
let restoreProtocol: (() => void) | undefined;
beforeEach(() => {
  fixture = replicaFixture('rbook-upgrade-judge-');
});
afterEach(() => {
  restoreProtocol?.();
  restoreProtocol = undefined;
  jest.restoreAllMocks();
  fixture.restore();
});
const OLD_REASON = "protocol 2 is newer than this copy's 1";
const history = (copy: Copy) =>
  read(copy, 'SELECT * FROM record_changes ORDER BY replica_id, replica_seq');
const decisions = (copy: Copy) =>
  read(
    copy,
    "SELECT decision_text FROM strategic_decisions WHERE decision_text = 'Stored for a future reader.'"
  );

/** Synthetic historical focused fixture; the published-4.2 fixture is independently built by the mission integration. */
async function legacy(reason: string | null | false = OLD_REASON, protocol = 2, author = 'member') {
  const restoreOld = upgradeRecordProtocolForTesting(1);
  try {
    const owner = await ownerCopy(fixture.tmp);
    const member = await joinedCopy(fixture.tmp, owner, 'member', author);
    useMachine(fixture.tmp, member.machine);
    const made = await call('rbook_decisions', {
      action: 'record',
      content: 'Stored for a future reader.',
      projectRoot: member.root,
    });
    expect(made.success).toBe(true);
    const [create] = read<{ txn_id: string }>(
      member,
      "SELECT txn_id FROM record_changes WHERE kind = 'create' AND entity = 'strategic_decisions' AND json_extract(value, '$.decision_text') = 'Stored for a future reader.'"
    );
    const incoming = (
      await onCopy(fixture.tmp, member, (client) => changesSince(client, {}))
    ).filter((change) => change.replica_id === member.replicaId);
    await onCopy(
      fixture.tmp,
      owner,
      (client) => {
        // A real older judge accepted the protocol-one session this decision references.
        expect(
          applyRemote(
            client,
            incoming.filter((change) => change.txn_id !== create.txn_id)
          ).success
        ).toBe(true);
        expect(
          applyRemote(
            client,
            incoming.filter((change) => change.txn_id === create.txn_id),
            { judge: false }
          ).success
        ).toBe(true);
        if (reason !== false)
          expect(
            client.writeTransaction(() =>
              recordOwnChanges(client, [
                {
                  kind: 'verdict',
                  entity: 'txn',
                  entityId: create.txn_id,
                  field: null,
                  value: JSON.stringify({
                    verdict: 'refused',
                    reason,
                    epoch: mergeContext(client).epoch,
                    replica: member.replicaId,
                  }),
                },
              ])
            ).success
          ).toBe(true);
      },
      { replicaCheck: false }
    );
    const db = new Database(dbOf(owner.root));
    try {
      db.prepare('UPDATE record_changes SET protocol_version = ? WHERE txn_id = ?').run(
        protocol,
        create.txn_id
      );
    } finally {
      db.close();
    }
    expect(decisions(owner)).toEqual([]);
    return { owner, member, txn: create.txn_id };
  } finally {
    restoreOld();
    restoreProtocol = upgradeRecordProtocolForTesting(2);
  }
}
async function opened(
  copy: Copy,
  options: { readonly?: boolean; replicaCheck?: boolean; timeout?: number } = {}
) {
  useMachine(fixture.tmp, copy.machine);
  const result = await RbookDatabaseClient.create({
    dbPath: dbOf(copy.root),
    registerProject: false,
    loadVec: false,
    ...options,
  });
  result.data?.close();
  return result;
}
const verdicts = (copy: Copy, txn: string) =>
  read<{ verdict: string; reason: string | null }>(
    copy,
    "SELECT json_extract(value,'$.verdict') AS verdict, json_extract(value,'$.reason') AS reason FROM record_changes WHERE kind='verdict' AND entity_id=? ORDER BY replica_seq",
    [txn]
  );

it('a checked writable open accepts the old protocol refusal once and preserves its old verdict', async () => {
  const { owner, txn } = await legacy();
  expect((await opened(owner)).success).toBe(true);
  expect(decisions(owner)).toHaveLength(1);
  expect(verdicts(owner, txn)).toEqual([
    { verdict: 'refused', reason: OLD_REASON },
    { verdict: 'accepted', reason: null },
  ]);
  const after = history(owner);
  expect((await opened(owner)).success).toBe(true);
  expect(history(owner)).toEqual(after);
});

it('a supported-now no-verdict transaction is judged, but an ordinary protocol-one pending transaction is not', async () => {
  const { owner, txn } = await legacy(false);
  expect((await opened(owner)).success).toBe(true);
  expect(decisions(owner)).toHaveLength(1);
  expect(verdicts(owner, txn)).toEqual([{ verdict: 'accepted', reason: null }]);
});

it.each([
  ['ordinary pending', false, 1],
  ['explicit refusal', 'A person refused this transaction.', 2],
  ['dependency refusal', 'it depends on stable-parent, whose create was refused', 2],
  ['NULL reason', null, 2],
  ['still unreadable', "protocol 3 is newer than this copy's 1", 3],
] as const)('does not reopen %s', async (_label, reason, protocol) => {
  const { owner } = await legacy(reason, protocol);
  const before = history(owner);
  expect((await opened(owner)).success).toBe(true);
  expect(history(owner)).toEqual(before);
  expect(decisions(owner)).toEqual([]);
});

it('read-only, unchecked, read-classified and review-role opens do not perform upgrade writes', async () => {
  const { owner } = await legacy();
  const before = history(owner);
  expect((await opened(owner, { readonly: true })).success).toBe(true);
  expect((await opened(owner, { replicaCheck: false })).success).toBe(true);
  const capture = await captureToolCall('read', () => opened(owner));
  expect(capture.value.success).toBe(true);
  const was = process.env.RBOOK_AGENT_ROLE;
  process.env.RBOOK_AGENT_ROLE = 'review';
  try {
    expect((await opened(owner)).success).toBe(true);
  } finally {
    if (was === undefined) delete process.env.RBOOK_AGENT_ROLE;
    else process.env.RBOOK_AGENT_ROLE = was;
  }
  expect(history(owner)).toEqual(before);
  expect(decisions(owner)).toEqual([]);
});

it('authorized judging apply retries stored protocol history even when its client was opened unchecked', async () => {
  const { owner } = await legacy();
  const result = await onCopy(fixture.tmp, owner, (client) => applyRemote(client, []), {
    replicaCheck: false,
  });
  expect(result.success).toBe(true);
  expect(result.data!.judged).toBe(1);
  expect(result.data!.newlyLive.length).toBeGreaterThan(0);
  expect(decisions(owner)).toHaveLength(1);
});

it('a failed upgrade verdict INSERT is surfaced and leaves the whole old history intact', async () => {
  const { owner } = await legacy();
  const db = new Database(dbOf(owner.root));
  try {
    db.exec(
      "CREATE TRIGGER reject_upgrade BEFORE INSERT ON record_changes WHEN NEW.kind='verdict' BEGIN SELECT RAISE(ABORT,'upgrade verdict failed'); END"
    );
  } finally {
    db.close();
  }
  const before = history(owner);
  const result = await opened(owner);
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain('upgrade verdict failed');
  expect(history(owner)).toEqual(before);
  expect(decisions(owner)).toEqual([]);
});

it('a competing SQLite writer prevents the upgrade rather than silently skipping it', async () => {
  const { owner } = await legacy();
  const before = history(owner),
    held = new Database(dbOf(owner.root));
  held.exec('BEGIN IMMEDIATE');
  try {
    const result = await opened(owner, { timeout: 0 });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/locked|busy/i);
  } finally {
    held.exec('ROLLBACK');
    held.close();
  }
  expect(history(owner)).toEqual(before);
});

it('a nonjudging apply does not retry stored history', async () => {
  const { owner } = await legacy();
  const before = history(owner);
  const result = await onCopy(
    fixture.tmp,
    owner,
    (client) => applyRemote(client, [], { judge: false }),
    { replicaCheck: false }
  );
  expect(result.success).toBe(true);
  expect(result.data?.judged).toBe(0);
  expect(history(owner)).toEqual(before);
});

it('upgrade replay applies the current member cut instead of overriding it with historical eligibility', async () => {
  const { owner, member, txn } = await legacy();
  await onCopy(
    fixture.tmp,
    owner,
    (client) => {
      const memberId = mergeContext(client).members.get(member.replicaId)!.member!;
      expect(
        client.writeTransaction(() =>
          recordOwnChanges(client, [
            {
              kind: 'member',
              entity: '__member__',
              entityId: memberId,
              field: null,
              value: JSON.stringify({
                name: 'member',
                role: 'removed',
                cuts: { [member.replicaId]: 0 },
              }),
            },
          ])
        ).success
      ).toBe(true);
    },
    { replicaCheck: false }
  );
  expect((await opened(owner)).success).toBe(true);
  expect(verdicts(owner, txn).map((value) => value.verdict)).toEqual(['refused', 'quarantined']);
  expect(decisions(owner)).toEqual([]);
});

it('a failed upgrade activation query is surfaced, with no silent skip or partial write', async () => {
  const { owner } = await legacy();
  const before = history(owner);
  const original = RbookDatabaseClient.prototype.getMany;
  let injected = 0;
  jest.spyOn(RbookDatabaseClient.prototype, 'getMany').mockImplementation(function (
    this: RbookDatabaseClient,
    sql,
    params
  ) {
    if (sql.includes('HAVING max(protocol_version)')) {
      injected++;
      return createError({
        code: 'DB_READ_FAILED',
        message: 'upgrade activation query failed',
        suggestion: 'Inspect the fixture.',
      });
    }
    return original.call(this, sql, params);
  });
  const result = await opened(owner);
  expect(injected).toBe(1);
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain('upgrade activation query failed');
  expect(history(owner)).toEqual(before);
});

it.each(['create', 'sync callback', 'async error callback'] as const)(
  'keeps upgrade warnings on the %s result',
  async (mode) => {
    const { owner } = await legacy();
    jest
      .spyOn(derived, 'embedMergedRows')
      .mockResolvedValue({ embedded: 0, warnings: ['upgrade embedding unavailable'] });
    useMachine(fixture.tmp, owner.machine);
    const options = { dbPath: dbOf(owner.root), registerProject: false, loadVec: false };
    const result =
      mode === 'create'
        ? await opened(owner)
        : mode === 'sync callback'
          ? await withClient(
              () => createSuccess('callback preserved', ['existing handler warning']),
              options
            )
          : await withClientAsync(
              async () => ({
                ...createError({
                  code: 'HANDLER_REFUSED',
                  message: 'Callback refusal preserved',
                  suggestion: 'Read the fixture.',
                }),
                warnings: ['existing handler warning'],
              }),
              options
            );
    expect(result.warnings).toContain('upgrade embedding unavailable');
    if (mode !== 'create') expect(result.warnings).toContain('existing handler warning');
    if (mode === 'sync callback') expect(result.data).toBe('callback preserved');
    if (mode === 'async error callback') expect(result.error?.code).toBe('HANDLER_REFUSED');
    expect(decisions(owner)).toHaveLength(1);
  }
);

it.each([OLD_REASON, 'A person refused this transaction.'])(
  'only retries the earlier protocol refusal after promotion: %s',
  async (reason) => {
    const { owner, member, txn } = await legacy(reason, 2, 'Owner');
    // Model the newer author's original stored row, not only the old receiver's copied stamp.
    const db = new Database(dbOf(member.root));
    try {
      db.prepare('UPDATE record_changes SET protocol_version=2 WHERE txn_id=?').run(txn);
    } finally {
      db.close();
    }
    const moved = await onCopy(
      fixture.tmp,
      owner,
      (client) => handOver(client, { to: member.replicaId }),
      { replicaCheck: false }
    );
    expect(moved.success).toBe(true);
    const all = await onCopy(fixture.tmp, owner, (client) => changesSince(client, {}), {
      replicaCheck: false,
    });
    await onCopy(
      fixture.tmp,
      member,
      (client) => {
        expect(applyRemote(client, all, { judge: false }).success).toBe(true);
        expect(confirmOwner(client, { changeId: moved.data!.changeId }).success).toBe(true);
      },
      { replicaCheck: false }
    );
    expect(verdicts(member, txn).map((value) => value.verdict)).toEqual(['refused']);
    expect(decisions(member)).toEqual([]);
    expect((await opened(member)).success).toBe(true);
    const governing = await onCopy(
      fixture.tmp,
      member,
      (client) => countedVerdicts(client, mergeContext(client), txn).map((value) => value.verdict),
      { replicaCheck: false }
    );
    expect(governing).toEqual(reason === OLD_REASON ? ['refused', 'accepted'] : ['refused']);
    expect(decisions(member)).toHaveLength(reason === OLD_REASON ? 1 : 0);
  }
);
