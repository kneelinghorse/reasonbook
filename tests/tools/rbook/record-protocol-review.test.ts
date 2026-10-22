// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Protocol information is neither a conflict nor a state requiring repair, and every blocker stays named.
// ABOUTME: Actual MCP review keeps precise JSON size accounting while the separate rendered digest remains bounded.
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import { rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import { sharedRecordReview } from '../../../src/tools/rbook/record-review';
import { sharedRecordText, renderDigestV2 } from '../../../src/tools/rbook/digest-v2';
import { formatReviewForLLM, type RbookReviewResult } from '../../../src/tools/rbook/rbook-review';
import {
  call,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { onCopy, ownerCopy, read } from '../../helpers/shared-copies';
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-protocol-review-');
});
afterEach(() => fixture.restore());
it('a healthy shared record never invents conflict states or directs the operator to conflicts', async () => {
  const owner = await ownerCopy(fixture.tmp);
  await onCopy(fixture.tmp, owner, (client) => {
    const review = sharedRecordReview(client)!;
    expect(review.states).toEqual([]);
    expect(review.conflicts).toEqual([]);
    expect(sharedRecordText(review)).not.toMatch(/state\(s\) need a person|action="conflicts"/);
  });
});
it.each([2, 35])(
  'actual MCP review retains every named blocker, count=%i, with honest size and bounded rendered text',
  async (count) => {
    const undo = upgradeRecordProtocolForTesting(1);
    let owner: Awaited<ReturnType<typeof ownerCopy>>;
    try {
      owner = await ownerCopy(fixture.tmp);
      await onCopy(fixture.tmp, owner, (client) => {
        expect(
          client.writeTransaction(() => {
            for (let index = 0; index < count; index++) {
              recordOwnChanges(client, [
                {
                  kind: 'member',
                  entity: 'member',
                  entityId: 'person-' + index,
                  field: null,
                  value: JSON.stringify({ name: 'Blocking Member ' + index, role: 'editor' }),
                },
                {
                  kind: 'replica_joined',
                  entity: 'replica',
                  entityId: 'replica-' + index,
                  field: null,
                  value: JSON.stringify({
                    block: index + 1,
                    role: 'editor',
                    member: 'person-' + index,
                  }),
                },
              ]);
              rememberCopyReport(client, 'replica-' + index, { reads: 1 }, { called: true });
            }
          }).success
        ).toBe(true);
      });
    } finally {
      undo();
    }
    useMachine(fixture.tmp, owner!.machine);
    const answer = await call('rbook_review', { projectRoot: owner!.root });
    expect(answer.success).toBe(true);
    const data = answer.data as unknown as RbookReviewResult & {
      recordProtocol?: { writeProtocol: number; blockers: Array<{ memberName: string }> };
    };
    expect(data.recordProtocol?.writeProtocol).toBe(1);
    expect(data.recordProtocol?.blockers.map((copy) => copy.memberName).sort()).toEqual(
      Array.from({ length: count }, (_, i) => 'Blocking Member ' + i).sort()
    );
    expect(data.digestSizeBytes).toBe(Buffer.byteLength(JSON.stringify(data), 'utf8'));
    if (count === 2) expect(data.digestSizeBytes).toBeLessThanOrEqual(4096);
    else {
      expect(data.digestSizeBytes).toBeGreaterThan(4096);
      expect(formatReviewForLLM({ success: true, data })).toMatch(/exceeds.*all blocking copies/i);
    }
    expect(data.sharedRecord).not.toMatch(/state\(s\) need a person|action="conflicts"/);
    await onCopy(fixture.tmp, owner!, (client) => {
      const review = sharedRecordReview(client)!;
      const model = {
        project: { name: 'Protocol review', level: 'builder' as const },
        localProjectId: null,
        sprint: null,
        profile: {
          path: '/owned/profile',
          text: 'profile '.repeat(140),
          chars: 1120,
          overCap: false,
        },
        stepUp: null,
        rules: [],
        decisions: { rows: [], total: 0 },
        learnings: { rows: [], total: 0 },
        work: [],
        shared: review,
      };
      const rendered = renderDigestV2(model).text;
      expect(rendered.length).toBeLessThanOrEqual(4000);
      expect(rendered).toMatch(/protocol 1.*block/i);
      const crowded = {
        ...review,
        conflicts: Array.from({ length: 20 }, (_, i) => 'long conflict ' + i + 'x'.repeat(100)),
        upgrade: 'held newer stream',
      };
      const compact = sharedRecordText(crowded)!;
      expect(compact.length).toBeLessThanOrEqual(600);
      expect(compact).toMatch(/newer record protocol wait/);
      expect(compact).toMatch(/protocol 1.*block/i);
    });
  }
);

it.each(['returned query failure', 'thrown JSON error'])(
  'actual MCP review warns about %s without writing or pretending protocol status is known',
  async (failure) => {
    const owner = await ownerCopy(fixture.tmp);
    const before = read(owner, 'SELECT * FROM record_changes ORDER BY change_id');
    const original = RbookDatabaseClient.prototype.getOne;
    let failedReads = 0;
    const spy = jest.spyOn(RbookDatabaseClient.prototype, 'getOne').mockImplementation(function (
      this: RbookDatabaseClient,
      sql,
      params
    ) {
      if (
        sql.includes('protocol_version = 2 ORDER BY replica_seq LIMIT 1') &&
        new Error().stack?.includes('readSharedRecordText')
      ) {
        failedReads++;
        if (failure === 'thrown JSON error') throw new SyntaxError('injected protocol JSON error');
        return {
          success: false,
          error: { code: 'DB_QUERY_FAILED', message: 'injected protocol query failure' },
        };
      }
      return original.call(this, sql, params);
    });
    let answer: Awaited<ReturnType<typeof call>> & { warnings?: string[] };
    try {
      answer = await call('rbook_review', { projectRoot: owner.root });
    } finally {
      spy.mockRestore();
    }
    expect(failedReads).toBeGreaterThan(0);
    expect(answer).toMatchObject({ success: true });
    expect(answer.data?.recordProtocol).toBeUndefined();
    expect(answer.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /Shared-record.*could not be read.*injected protocol.*Retry rbook_review/i
        ),
      ])
    );
    expect(formatReviewForLLM(answer as Parameters<typeof formatReviewForLLM>[0])).toMatch(
      /Shared-record.*could not be read.*injected protocol/i
    );
    expect(read(owner, 'SELECT * FROM record_changes ORDER BY change_id')).toEqual(before);
  }
);
it('an unshared store omits protocol information without a shared-record read warning', async () => {
  useMachine(fixture.tmp, 'unshared');
  const root = project(fixture.tmp, 'unshared');
  const answer = (await call('rbook_review', { projectRoot: root })) as Awaited<
    ReturnType<typeof call>
  > & { warnings?: string[] };
  expect(answer.success).toBe(true);
  expect(answer.data?.recordProtocol).toBeUndefined();
  expect(answer.warnings ?? []).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/Shared-record.*could not be read/i)])
  );
});

it.each([false, true])(
  'compact shared text retains waiting counts and recovery conditions: %s',
  async (heldRecovery) => {
    const owner = await ownerCopy(fixture.tmp);
    await onCopy(fixture.tmp, owner, (client) => {
      for (const state of ['held', 'pending', 'quarantined', 'refused']) {
        expect(
          client.execute(
            'INSERT INTO record_txn_state(txn_id,replica_id,state,cause) VALUES (?,?,?,?)',
            ['waiting-' + state, owner.replicaId, state, 'detailed cause '.repeat(30)]
          ).success
        ).toBe(true);
      }
      const review = sharedRecordReview(client)!;
      const recoveryConditions = [
        'move',
        'epoch',
        'previous',
        'authority',
        'membership',
        'cut',
      ].map((condition) => `${condition} condition`);
      const compact = sharedRecordText({
        ...review,
        ...(heldRecovery ? { recoveryConditions } : {}),
        conflicts: Array.from({ length: 20 }, (_, i) => 'long conflict ' + i + 'x'.repeat(100)),
        states: ['A real constraint needs attention'],
        moves: ['Pending owner move'],
        movePending: true,
        removed: true,
        upgrade: 'held newer stream',
        syncErrors: 2,
      })!;
      expect(compact).toMatch(/1 quarantined/);
      expect(compact).toMatch(/1 held.*1 pending.*1 quarantined.*1 refused/);
      expect(compact.length).toBeLessThanOrEqual(600);
      expect(compact).toMatch(/protocol 1/);
      expect(compact).toMatch(/newer record protocol wait/);
      if (heldRecovery) {
        for (const condition of recoveryConditions) expect(compact).toContain(condition);
        expect(compact).toContain('--confirm-owner');
        expect(compact).toContain('fix invalid chains first');
      }
    });
  }
);

it.each([1, 10, 1_000, 1_000_000])(
  'a switched compact review keeps every recovery condition with %i waiting per state',
  async (count) => {
    const owner = await ownerCopy(fixture.tmp);
    await onCopy(fixture.tmp, owner, (client) => {
      expect(
        client.writeTransaction(() => {
          recordOwnChanges(client, [
            {
              kind: 'member',
              entity: 'member',
              entityId: 'budget-member',
              field: null,
              value: JSON.stringify({ name: 'Budget Member', role: 'editor' }),
            },
          ]);
        }).success
      ).toBe(true);
      const review = sharedRecordReview(client)!;
      expect(review.protocol?.writeProtocol).toBe(2);
      const recoveryConditions = [
        'move',
        'epoch',
        'previous',
        'authority',
        'membership',
        'cut',
      ].map((condition) => `${condition} condition`);
      // Counts are a rendering projection, not a claim to insert millions of database rows.
      const compact = sharedRecordText({
        ...review,
        conflicts: Array.from({ length: 20 }, () => 'A detailed conflict '.repeat(20)),
        states: ['A constraint needs attention'],
        waiting: ['A detailed waiting cause '.repeat(30)],
        waitingTotal: count * 4,
        waitingCounts: { held: count, pending: count, quarantined: count, refused: count },
        moves: ['A detailed held recovery '.repeat(30)],
        recoveryConditions,
        movePending: true,
        removed: true,
        upgrade: 'held newer stream',
        syncErrors: 2,
      });
      expect(compact).not.toBeNull();
      expect(compact!.length).toBeLessThanOrEqual(600);
      for (const condition of recoveryConditions) expect(compact).toContain(condition);
      expect(compact).toContain(`${count} quarantined`);
      expect(compact).toContain('--confirm-owner');
      expect(compact).toContain('fix invalid chains first');
      expect(compact).toMatch(/record protocol 2.*switched/);
      expect(compact).toMatch(/downgrad.*rename ids/);
      expect(compact).toMatch(/newer record protocol wait/);
      expect(compact).toMatch(/member was removed/);
      expect(compact).toContain('sync error');
    });
  }
);
