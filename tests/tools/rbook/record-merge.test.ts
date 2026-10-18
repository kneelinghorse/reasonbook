// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m12 (ADR s96 §5, §7) — copies of a shared record converge: the owner judges, members adopt its verdicts,
// ABOUTME: concurrent changes to a field are kept as candidates, appends keep every entry, and refusals recompute.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  call,
  record,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import {
  exchange,
  memberCopy,
  ownerCopy,
  read,
  sync,
  type Copy,
} from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-merge-');
});
afterEach(() => fixture.restore());

/** Run a tool call on a copy's own machine. */
async function on<T>(copy: Copy, run: () => Promise<T>): Promise<T> {
  useMachine(fixture.tmp, copy.machine);
  return run();
}

async function ok(copy: Copy, tool: string, args: Record<string, unknown>) {
  const answer = await on(copy, () => call(tool, { ...args, projectRoot: copy.root }));
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

const decisions = (copy: Copy) =>
  read<{ stable_event_id: string; decision_text: string; status: string }>(
    copy,
    'SELECT stable_event_id, decision_text, status FROM strategic_decisions ORDER BY stable_event_id'
  );

describe('a member and the owner', () => {
  it("a member's write reaches the owner, is accepted, and its verdict comes back", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await sync(fixture.tmp, owner, member);
    const made = await on(member, () => record(member.root, 'A choice the member made.'));
    expect(made.error).toBeUndefined();
    const toOwner = await sync(fixture.tmp, member, owner);
    expect(toOwner.judged).toBeGreaterThan(0);
    await sync(fixture.tmp, owner, member);
    expect(decisions(owner)).toEqual(decisions(member));
    expect(decisions(owner).map((row) => row.decision_text)).toContain('A choice the member made.');
    // Accepted: nothing stands apart on either copy.
    expect(read(member, 'SELECT * FROM record_txn_state')).toEqual([]);
    expect(read(owner, 'SELECT * FROM record_txn_state')).toEqual([]);
  });

  it("a member's copy refuses a project identity change before recording it; the owner's makes it", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await sync(fixture.tmp, owner, member);
    const logged = () => read(member, 'SELECT change_id FROM record_changes');
    const before = logged();
    const identity = (copy: Copy) =>
      on(copy, () =>
        call('rbook_context', {
          action: 'update',
          contextType: 'project_identity',
          fieldUpdates: [{ path: 'description', value: `Said by ${copy.name}.` }],
          projectRoot: copy.root,
        })
      );
    const tier = (copy: Copy) =>
      on(copy, () =>
        call('rbook_project', { action: 'update', projectType: 'managed', projectRoot: copy.root })
      );
    for (const refused of [await identity(member), await tier(member)]) {
      expect(refused.error).toMatchObject({
        code: 'RECORD_WRITE_REFUSED',
        message: expect.stringMatching(/Only the owner's copy .* changes the project identity/),
        suggestion: expect.stringMatching(/on the owner's copy/),
      });
    }
    expect(logged()).toEqual(before);
    expect(
      read<{ content: string }>(
        member,
        "SELECT content FROM contexts WHERE id = 'project_identity'"
      )[0].content
    ).not.toContain('Said by member.');
    expect((await identity(owner)).success).toBe(true);
    await sync(fixture.tmp, owner, member);
    expect(
      read<{ content: string }>(
        member,
        "SELECT content FROM contexts WHERE id = 'project_identity'"
      )[0].content
    ).toContain('Said by owner.');
  });

  it('two concurrent changes to one field are kept on both copies, with one provisional value', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const made = await on(owner, () => record(owner.root, 'A choice to argue over.'));
    const id = made.data!.decisionId;
    await sync(fixture.tmp, owner, member);
    await ok(owner, 'rbook_decisions', { action: 'update', decisionId: id, status: 'archived' });
    await ok(member, 'rbook_decisions', { action: 'update', decisionId: id, status: 'stale' });
    await exchange(fixture.tmp, owner, member);
    await sync(fixture.tmp, owner, member);
    for (const copy of [owner, member])
      expect({
        copy: copy.name,
        conflicts: read(copy, 'SELECT entity, field FROM record_conflicts'),
      }).toEqual({
        copy: copy.name,
        conflicts: [{ entity: 'strategic_decisions', field: 'status' }],
      });
    expect(decisions(owner)).toEqual(decisions(member));
    const heads = (copy: Copy) =>
      read<{ change_id: string }>(
        copy,
        "SELECT change_id FROM record_heads WHERE entity = 'strategic_decisions' AND field = 'status' ORDER BY change_id"
      );
    expect(heads(owner)).toHaveLength(2);
    expect(heads(owner)).toEqual(heads(member));
  });
});

const missionNotes = (copy: Copy, id: string): string =>
  read<{ notes: string | null }>(copy, 'SELECT notes FROM missions WHERE id = ?', [id])[0]?.notes ??
  '';

async function appendNote(copy: Copy, id: string, note: string): Promise<void> {
  const current = missionNotes(copy, id);
  await ok(copy, 'rbook_mission', {
    action: 'update',
    missionId: id,
    fields: { notes: `${current}${note}` },
  });
}

describe('fields that merge without a conflict', () => {
  it.each([
    ['made after sharing', true],
    ['the baseline holds', false],
  ])(
    'two concurrent note appends keep both entries, in one order, on a mission %s',
    async (_name, after) => {
      const seededRoot = async (): Promise<Copy> => {
        const owner = await ownerCopy(fixture.tmp);
        return owner;
      };
      let owner: Copy;
      if (after) {
        owner = await seededRoot();
        await ok(owner, 'rbook_mission', { action: 'add', missionId: 'n-m01', name: 'Noted' });
      } else {
        // The mission exists before the project is shared, so the log holds no create for it.
        const { project } = await import('../../helpers/replica-fixture');
        const root = project(fixture.tmp, 'owner');
        useMachine(fixture.tmp, 'machine-owner');
        const added = await call('rbook_mission', {
          action: 'add',
          missionId: 'n-m01',
          name: 'Noted',
          notes: 'Before sharing.',
          projectRoot: root,
        });
        expect(added.success).toBe(true);
        const { onCopy } = await import('../../helpers/shared-copies');
        const { writeUserAuthor } = await import('../../../src/intelligence/user-author');
        const { prepareForSharing } =
          await import('../../../src/tools/rbook/sharing-preconditions');
        const { shareRecord } = await import('../../../src/tools/rbook/record-share');
        writeUserAuthor('Owner');
        const replicaId = await onCopy(
          fixture.tmp,
          { root, machine: 'machine-owner' },
          (client) => {
            prepareForSharing(client);
            return shareRecord(client).replicaId;
          },
          { replicaCheck: false }
        );
        owner = { name: 'owner', root, machine: 'machine-owner', replicaId, block: 0 };
      }
      const member = await memberCopy(fixture.tmp, owner, 'member', 1);
      await sync(fixture.tmp, owner, member);
      await appendNote(owner, 'n-m01', ' From the owner.');
      await appendNote(member, 'n-m01', ' From the member.');
      await exchange(fixture.tmp, owner, member);
      await sync(fixture.tmp, owner, member);
      const notes = missionNotes(owner, 'n-m01');
      expect(notes).toContain(' From the owner.');
      expect(notes).toContain(' From the member.');
      if (!after) expect(notes.startsWith('Before sharing.')).toBe(true);
      expect(missionNotes(member, 'n-m01')).toBe(notes);
      expect(read(owner, 'SELECT * FROM record_conflicts')).toEqual([]);
    }
  );

  it('a flag set and cleared at once ends set, and a review takes the later time, with no conflict', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const learned = await ok(owner, 'rbook_session', {
      action: 'capture',
      category: 'learning',
      content: 'A lesson.',
    });
    const learningId = learned.data!.learningId;
    await ok(owner, 'rbook_learnings', { action: 'update', learningId, evergreen: true });
    await sync(fixture.tmp, owner, member);
    await ok(owner, 'rbook_learnings', { action: 'update', learningId, evergreen: false });
    await ok(member, 'rbook_learnings', { action: 'reaffirm', learningId });
    await ok(member, 'rbook_learnings', { action: 'update', learningId, evergreen: true });
    await exchange(fixture.tmp, owner, member);
    await sync(fixture.tmp, owner, member);
    const learning = (copy: Copy) =>
      read<{ evergreen: number; last_reviewed_at: string }>(
        copy,
        'SELECT evergreen, last_reviewed_at FROM learnings WHERE id = ?',
        [learningId]
      )[0];
    expect(learning(owner)).toEqual(learning(member));
    expect(read(owner, 'SELECT * FROM record_conflicts')).toEqual([]);
  });

  it('a removal takes only the links its writer saw', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    for (const missionId of ['l-m01', 'l-m02'])
      await ok(owner, 'rbook_mission', { action: 'add', missionId, name: missionId });
    await sync(fixture.tmp, owner, member);
    // Both copies add the same dependency; the owner removes it having seen only its own.
    await ok(owner, 'rbook_mission', { action: 'depends', fromId: 'l-m02', toId: 'l-m01' });
    await ok(member, 'rbook_mission', { action: 'depends', fromId: 'l-m02', toId: 'l-m01' });
    await ok(owner, 'rbook_mission', { action: 'undepends', fromId: 'l-m02', toId: 'l-m01' });
    await exchange(fixture.tmp, owner, member);
    await sync(fixture.tmp, owner, member);
    const edges = (copy: Copy) => read(copy, 'SELECT from_id, to_id FROM mission_dependencies');
    expect(edges(owner)).toEqual([{ from_id: 'l-m02', to_id: 'l-m01' }]);
    expect(edges(member)).toEqual(edges(owner));
    // Once a removal has seen both, the link is gone everywhere.
    await ok(owner, 'rbook_mission', { action: 'undepends', fromId: 'l-m02', toId: 'l-m01' });
    await exchange(fixture.tmp, owner, member);
    expect(edges(owner)).toEqual([]);
    expect(edges(member)).toEqual([]);
  });
});

describe('refused, held and pending changes', () => {
  it('a copy the owner never admitted has its writes refused, and they recompute away', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const made = await on(owner, () => record(owner.root, 'A choice to keep.'));
    const id = made.data!.decisionId;
    const outsider = await memberCopy(fixture.tmp, owner, 'outsider', 2, { admit: false });
    await sync(fixture.tmp, owner, outsider);
    // Two writes on one field, the second on top of the first.
    await ok(outsider, 'rbook_decisions', { action: 'update', decisionId: id, status: 'archived' });
    await ok(outsider, 'rbook_decisions', { action: 'update', decisionId: id, status: 'stale' });
    await sync(fixture.tmp, outsider, owner);
    expect(decisions(owner)[0].status).toBe('active');
    await sync(fixture.tmp, owner, outsider);
    expect(decisions(outsider)).toEqual(decisions(owner));
    const states = read<{ state: string; cause: string }>(
      outsider,
      'SELECT state, cause FROM record_txn_state'
    );
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states.every((row) => row.state === 'refused' && /not a member/.test(row.cause))).toBe(
      true
    );
  });

  it('a refused write under a concurrent accepted one leaves the accepted value on every copy', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const made = await on(owner, () => record(owner.root, 'A choice two members touch.'));
    const id = made.data!.decisionId;
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const outsider = await memberCopy(fixture.tmp, owner, 'outsider', 2, { admit: false });
    await sync(fixture.tmp, owner, member);
    await sync(fixture.tmp, owner, outsider);
    await ok(member, 'rbook_decisions', { action: 'update', decisionId: id, status: 'archived' });
    await ok(outsider, 'rbook_decisions', { action: 'update', decisionId: id, status: 'stale' });
    await sync(fixture.tmp, member, owner);
    await sync(fixture.tmp, outsider, owner);
    await sync(fixture.tmp, owner, member);
    await sync(fixture.tmp, owner, outsider);
    for (const copy of [owner, member, outsider])
      expect(decisions(copy)[0].status).toBe('archived');
    expect(read(outsider, 'SELECT * FROM record_conflicts')).toEqual([]);
    // ADR s96 §7: the owner withholds a refused non-member's data, and its verdict travels alone.
    expect(
      read(member, 'SELECT count(*) AS n FROM record_changes WHERE replica_id = ?', [
        outsider.replicaId,
      ])
    ).toEqual([{ n: 0 }]);
    expect(read(member, 'SELECT replica_id, state FROM record_txn_state')).toEqual([
      { replica_id: outsider.replicaId, state: 'refused' },
    ]);
  });

  it('a change that arrives before the row it names is held, then applied when the row comes', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await sync(fixture.tmp, owner, member);
    await ok(owner, 'rbook_mission', { action: 'add', missionId: 'h-m01', name: 'Parent' });
    const made = await on(owner, () =>
      call('rbook_decisions', {
        action: 'record',
        content: 'For the parent.',
        missionId: 'h-m01',
        projectRoot: owner.root,
      })
    );
    expect(made.success).toBe(true);
    const { onCopy } = await import('../../helpers/shared-copies');
    const { changesSince, applyRemote, replicaMarks } =
      await import('../../../src/tools/rbook/record-apply');
    const marks = await onCopy(fixture.tmp, member, (client) => replicaMarks(client));
    const all = await onCopy(fixture.tmp, owner, (client) => changesSince(client, marks));
    const parentTxn = all.find(
      (change) => change.kind === 'create' && change.entity === 'missions'
    )!.txn_id;
    // Everything but the mission's transaction arrives first: the decision waits behind the gap.
    const first = await onCopy(fixture.tmp, member, (client) =>
      applyRemote(
        client,
        all.filter((change) => change.txn_id !== parentTxn)
      )
    );
    expect(first.success).toBe(true);
    expect(
      read(member, "SELECT state FROM record_txn_state WHERE state = 'held'").length
    ).toBeGreaterThan(0);
    expect(
      read(member, "SELECT 1 FROM strategic_decisions WHERE decision_text = 'For the parent.'")
    ).toEqual([]);
    await sync(fixture.tmp, owner, member);
    expect(read(member, "SELECT state FROM record_txn_state WHERE state = 'held'")).toEqual([]);
    expect(
      read<{ mission_id: string }>(
        member,
        "SELECT mission_id FROM strategic_decisions WHERE decision_text = 'For the parent.'"
      )
    ).toEqual([{ mission_id: 'h-m01' }]);
  });
});

/** Every copy sends to the owner, then the owner sends to every copy, twice so verdicts come round. */
async function settleRound(owner: Copy, members: readonly Copy[]): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    for (const member of members) await sync(fixture.tmp, member, owner);
    for (const member of members) await sync(fixture.tmp, owner, member);
  }
}

describe('five concurrent changes to one field, settled at the dispatch boundary', () => {
  const kinds: Array<[string, string, (copy: Copy, n: number) => Promise<unknown>, unknown]> = [
    [
      'a scalar',
      'name',
      (copy, n) =>
        ok(copy, 'rbook_mission', {
          action: 'update',
          missionId: 'k-m01',
          fields: { name: `Name ${n}` },
        }),
      'Name 2',
    ],
    [
      'a text',
      'objective',
      (copy, n) =>
        ok(copy, 'rbook_mission', {
          action: 'update',
          missionId: 'k-m01',
          fields: { objective: `Objective ${n}.` },
        }),
      'Objective 3.',
    ],
    [
      'a reference',
      'sprint_id',
      (copy, n) =>
        ok(copy, 'rbook_mission', {
          action: 'move',
          missionId: 'k-m01',
          toSprintId: `k-sprint-${n + 1}`,
          reason: `Move ${n}.`,
        }),
      'k-sprint-3',
    ],
    [
      'a JSON list',
      'success_criteria',
      (copy, n) =>
        ok(copy, 'rbook_mission', {
          action: 'update',
          missionId: 'k-m01',
          fields: { successCriteria: [`Criterion ${n}.`] },
        }),
      JSON.stringify(['Criterion 1.']),
    ],
    [
      'a note replaced outright',
      'notes',
      (copy, n) =>
        ok(copy, 'rbook_mission', {
          action: 'update',
          missionId: 'k-m01',
          fields: { notes: `Notes ${n}.` },
        }),
      'Notes 4.',
    ],
  ];

  it.each(kinds)(
    '%s',
    async (_name, field, write, keep) => {
      const owner = await ownerCopy(fixture.tmp);
      for (let n = 0; n <= 5; n += 1)
        await ok(owner, 'rbook_sprint', {
          action: 'add',
          sprintId: `k-sprint-${n}`,
          title: `K ${n}`,
          status: 'Planned',
        });
      await ok(owner, 'rbook_mission', {
        action: 'add',
        missionId: 'k-m01',
        name: 'Contested',
        sprintId: 'k-sprint-0',
        notes: 'Notes.',
      });
      const members: Copy[] = [];
      for (let block = 1; block <= 4; block += 1)
        members.push(await memberCopy(fixture.tmp, owner, `member-${block}`, block));
      const copies = [owner, ...members];
      for (const [n, copy] of copies.entries()) await write(copy, n);
      await settleRound(owner, members);
      const row = (copy: Copy) =>
        read<Record<string, unknown>>(
          copy,
          `SELECT "${field}" AS value FROM missions WHERE id = 'k-m01'`
        )[0].value;
      for (const copy of copies) {
        const open = read<{ field: string }>(
          copy,
          "SELECT field FROM record_conflicts WHERE entity = 'missions'"
        );
        expect({ copy: copy.name, open }).toEqual({ copy: copy.name, open: [{ field }] });
        expect(
          read(
            copy,
            `SELECT change_id FROM record_heads WHERE entity = 'missions' AND field = '${field}'`
          )
        ).toHaveLength(5);
        expect(row(copy)).toEqual(row(owner));
      }
      // Every value is kept, and a plain write is refused until it is settled.
      const listed = await ok(members[1], 'rbook_db', { action: 'conflicts' });
      const conflict = (
        listed.data as { conflicts: Array<{ field: string; candidates: unknown[] }> }
      ).conflicts.find((open) => open.field === field)!;
      expect(conflict.candidates).toHaveLength(5);
      const refused = await on(members[1], () =>
        call('rbook_mission', {
          action: 'update',
          missionId: 'k-m01',
          fields: { objective: 'Plain write.' },
          projectRoot: members[1].root,
        })
      );
      if (field === 'objective') {
        expect(refused.error?.code).toBe('FIELD_IN_CONFLICT');
        expect(refused.error?.suggestion).toMatch(/rbook_db\(action="settle"/);
      }
      await ok(members[1], 'rbook_db', {
        action: 'settle',
        table: 'missions',
        recordId: 'k-m01',
        field,
        value: keep,
      });
      await settleRound(owner, members);
      for (const copy of copies) {
        expect({ copy: copy.name, open: read(copy, 'SELECT * FROM record_conflicts') }).toEqual({
          copy: copy.name,
          open: [],
        });
        expect(row(copy)).toEqual(row(owner));
      }
      expect(row(owner)).toEqual(keep);
    },
    120000
  );
});

describe('a set-based write skips a conflicted row', () => {
  it('carry-all names the next step whose target is in conflict, and carries the rest', async () => {
    const owner = await ownerCopy(fixture.tmp);
    for (const sprintId of ['c-sprint-1', 'c-sprint-2', 'c-sprint-3'])
      await ok(owner, 'rbook_sprint', {
        action: 'add',
        sprintId,
        title: sprintId,
        status: 'Planned',
      });
    for (const content of ['Contested step.', 'Plain step.'])
      await ok(owner, 'rbook_session', { action: 'capture', category: 'next-step', content });
    await ok(owner, 'rbook_session', { action: 'complete', summary: 'Closed.' });
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const [contested, plain] = read<{ id: number }>(owner, 'SELECT id FROM next_steps ORDER BY id');
    // Two copies carry the same step to different sprints, neither seeing the other.
    await ok(owner, 'rbook_context', {
      action: 'next_steps',
      nextStepAction: 'carry',
      nextStepIds: [contested.id],
      carryToSprint: 'c-sprint-1',
    });
    await ok(member, 'rbook_context', {
      action: 'next_steps',
      nextStepAction: 'carry',
      nextStepIds: [contested.id],
      carryToSprint: 'c-sprint-2',
    });
    await settleRound(owner, [member]);
    expect(
      read(owner, "SELECT field FROM record_conflicts WHERE entity = 'next_steps' ORDER BY field")
    ).toContainEqual({ field: 'carried_to_sprint' });
    const carried = await ok(owner, 'rbook_context', {
      action: 'next_steps',
      nextStepAction: 'carry',
      carryToSprint: 'c-sprint-3',
    });
    expect(JSON.stringify(carried)).toMatch(new RegExp(`Skipped next_steps ${contested.id}`));
    expect(
      read(owner, 'SELECT carried_to_sprint FROM next_steps WHERE id = ?', [plain.id])
    ).toEqual([{ carried_to_sprint: 'c-sprint-3' }]);
    expect(
      read<{ carried_to_sprint: string }>(
        owner,
        'SELECT carried_to_sprint FROM next_steps WHERE id = ?',
        [contested.id]
      )[0].carried_to_sprint
    ).not.toBe('c-sprint-3');
  }, 60000);
});

describe('one mission id created on two copies', () => {
  /** Each copy's references to a mission, as the stable id each resolves to on this copy. */
  const resolved = (copy: Copy) => ({
    missions: read<{ id: string; stable_event_id: string }>(
      copy,
      "SELECT id, stable_event_id FROM missions WHERE id LIKE 'a-m01%' ORDER BY id"
    ),
    decisions: read<{ decision_text: string; stable: string }>(
      copy,
      "SELECT d.decision_text, m.stable_event_id AS stable FROM strategic_decisions d JOIN missions m ON m.id = d.mission_id WHERE d.decision_text LIKE 'For a-m01%' ORDER BY d.decision_text"
    ),
    captures: read<{ captures: string }>(
      copy,
      "SELECT captures FROM sessions WHERE captures LIKE '%a-m01%' ORDER BY id"
    )
      .flatMap((row) => JSON.parse(row.captures) as Array<{ content: string; missionId?: string }>)
      .filter((item) => item.missionId)
      .map((item) => ({
        content: item.content,
        stable: read<{ stable_event_id: string }>(
          copy,
          'SELECT stable_event_id FROM missions WHERE id = ?',
          [item.missionId]
        )[0]?.stable_event_id,
      }))
      .sort((a, b) => (a.content < b.content ? -1 : 1)),
  });

  async function both(owner: Copy, member: Copy): Promise<void> {
    for (const [copy, label] of [
      [owner, 'owner'],
      [member, 'member'],
    ] as const) {
      await ok(copy, 'rbook_mission', {
        action: 'add',
        missionId: 'a-m01',
        name: `The ${label}'s`,
      });
      await ok(copy, 'rbook_decisions', {
        action: 'record',
        content: `For a-m01, from the ${label}.`,
        missionId: 'a-m01',
      });
      await ok(copy, 'rbook_session', {
        action: 'capture',
        category: 'context',
        content: `Note from the ${label}.`,
        missionId: 'a-m01',
      });
    }
  }

  it.each([
    ["the member's first", true],
    ["the owner's first", false],
  ])(
    "ends with every reference naming its own creator's mission, arriving %s",
    async (_name, memberFirst) => {
      const owner = await ownerCopy(fixture.tmp);
      const member = await memberCopy(fixture.tmp, owner, 'member', 1);
      const third = await memberCopy(fixture.tmp, owner, 'third', 2);
      await both(owner, member);
      if (memberFirst) await exchange(fixture.tmp, owner, member);
      else {
        await sync(fixture.tmp, owner, member);
        await sync(fixture.tmp, member, owner);
      }
      await settleRound(owner, [member, third]);
      const ownerView = resolved(owner);
      expect(ownerView.missions.map((row) => row.id)).toEqual(['a-m01', 'a-m01~1']);
      for (const copy of [member, third]) expect(resolved(copy)).toEqual(ownerView);
      // Each copy's references name the mission its own copy created.
      const stableOf = (id: string) =>
        ownerView.missions.find((row) => row.id === id)!.stable_event_id;
      expect(ownerView.decisions).toEqual([
        { decision_text: 'For a-m01, from the member.', stable: stableOf('a-m01~1') },
        { decision_text: 'For a-m01, from the owner.', stable: stableOf('a-m01') },
      ]);
      expect(ownerView.captures).toEqual([
        { content: 'Note from the member.', stable: stableOf('a-m01~1') },
        { content: 'Note from the owner.', stable: stableOf('a-m01') },
      ]);
      for (const copy of [owner, member, third])
        expect(read(copy, 'SELECT entity, renamed_id, plain_id FROM record_aliases')).toEqual([
          { entity: 'missions', renamed_id: 'a-m01~1', plain_id: 'a-m01' },
        ]);
    },
    120000
  );
});

describe('what every answer from a shared copy says', () => {
  it('names each field in conflict with its candidates, and an id two copies created', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    for (const copy of [owner, member]) {
      await ok(copy, 'rbook_mission', {
        action: 'add',
        missionId: 'w-m01',
        name: `By ${copy.name}`,
      });
    }
    await ok(owner, 'rbook_mission', { action: 'add', missionId: 'w-m02', name: 'Shared' });
    await exchange(fixture.tmp, owner, member);
    await sync(fixture.tmp, owner, member);
    await ok(owner, 'rbook_mission', {
      action: 'update',
      missionId: 'w-m02',
      fields: { objective: 'The owner says.' },
    });
    await ok(member, 'rbook_mission', {
      action: 'update',
      missionId: 'w-m02',
      fields: { objective: 'The member says.' },
    });
    await exchange(fixture.tmp, owner, member);
    await sync(fixture.tmp, owner, member);
    const shown = await ok(member, 'rbook_mission', { action: 'show', missionId: 'w-m01' });
    const warnings = ((shown as { warnings?: string[] }).warnings ?? []).join('\n');
    // Values are quoted as JSON, so text and null read apart.
    expect(warnings).toMatch(
      /missions w-m02's objective shows .* one of "The owner says\." \(Owner\)/
    );
    expect(warnings).toMatch(/w-m01 names two missions: w-m01, created first, and w-m01~1/);
    // A solo store's answers carry neither.
    useMachine(fixture.tmp, 'solo-machine');
    const { project } = await import('../../helpers/replica-fixture');
    const solo = project(fixture.tmp, 'solo');
    const listed = await call('rbook_mission', { action: 'list', projectRoot: solo });
    expect(JSON.stringify(listed)).not.toMatch(/hold values from copies|names two missions/);
  }, 60000);
});
