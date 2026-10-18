// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m12 (ADR s96 §5, after a merge) — this copy's resume note and working memory name the session another
// ABOUTME: copy closed, once; its sessions stay its own; citations link by id; and merged rows are offered to embed.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { recordEmbedding } from '../../../src/intelligence/embedding-pipeline';
import { applyRemote, changesSince } from '../../../src/tools/rbook/record-apply';
import { embedMergedRows } from '../../../src/tools/rbook/record-derived';
import { recordedExecute } from '../../../src/tools/rbook/record-changes';
import { repairRecordLinksBatch } from '../../../src/tools/rbook/record-links';
import { loadLinkInventory } from '../../../src/tools/rbook/record-link-store';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { shareRecord } from '../../../src/tools/rbook/record-share';
import { reidentifyReplica } from '../../../src/tools/rbook/replica-check';
import {
  explicitSessionsAtStart,
  implicitSessionsToClose,
} from '../../../src/tools/rbook/session-owner';
import { prepareForSharing } from '../../../src/tools/rbook/sharing-preconditions';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  withClient,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import {
  exchange,
  memberCopy,
  onCopy,
  ownerCopy,
  read,
  sync,
  type Copy,
} from '../../helpers/shared-copies';

jest.mock('../../../src/intelligence/embedding-pipeline', () => ({
  ...jest.requireActual<object>('../../../src/intelligence/embedding-pipeline'),
  recordEmbedding: jest.fn(async () => ({ action: 'embedded', warnings: [] })),
}));

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-derived-');
});
afterEach(() => fixture.restore());

async function ok(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

const context = (copy: Copy, id: string) =>
  JSON.parse(
    read<{ content: string }>(copy, 'SELECT content FROM contexts WHERE id = ?', [id])[0]
      ?.content ?? '{}'
  );

async function memberSession(member: Copy, close: boolean): Promise<string> {
  const started = await ok(member, 'rbook_session', {
    action: 'start',
    type: 'planning',
    title: "The member's session",
  });
  const sessionId = started.data!.sessionId!;
  await ok(member, 'rbook_session', {
    action: 'capture',
    category: 'next-step',
    content: 'Wire the relay once it ships.',
  });
  if (close)
    await ok(member, 'rbook_session', {
      action: 'complete',
      summary: 'The member finished the merge notes.',
    });
  return sessionId;
}

describe('after a merge', () => {
  it("this copy's resume note and working memory name the session the other copy closed, once", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const sessionId = await memberSession(member, true);
    const report = await sync(fixture.tmp, member, owner);
    expect(report).toMatchObject({ folded: 1, notes: [] });
    const resume: string[] = context(owner, 'master_context').next_session_context.when_we_resume;
    expect(resume).toContain(`${sessionId}: Wire the relay once it ships.`);
    const history: Array<{ session: string }> = context(owner, 'project_context').working_memory
      .session_history;
    expect(history.map((entry) => entry.session)).toContain(sessionId);
    const onboard = await ok(owner, 'rbook_agent_onboard', {});
    expect((onboard.data as { lastSession?: { id: string } }).lastSession?.id).toBe(sessionId);
    // The same changes delivered again fold nothing more.
    const all = await onCopy(fixture.tmp, member, (client) => changesSince(client, {}));
    const again = await onCopy(fixture.tmp, owner, (client) => applyRemote(client, all));
    expect(again.data).toMatchObject({ stored: 0, folded: 0 });
    expect(
      (
        context(owner, 'project_context').working_memory.session_history as Array<{
          session: string;
        }>
      ).filter((entry) => entry.session === sessionId)
    ).toHaveLength(1);
  }, 120000);

  it('a session close that arrives behind a gap is folded by the delivery that releases it', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await ok(member, 'rbook_decisions', { action: 'record', content: 'Made before the session.' });
    const sessionId = await memberSession(member, true);
    const own = (await onCopy(fixture.tmp, member, (client) => changesSince(client, {}))).filter(
      (change) => change.replica_id === member.replicaId
    );
    const first = own[0].txn_id;
    const held = await onCopy(fixture.tmp, owner, (client) =>
      applyRemote(
        client,
        own.filter((change) => change.txn_id !== first)
      )
    );
    expect(held.data).toMatchObject({ folded: 0 });
    expect(held.data!.held).toBeGreaterThan(0);
    const released = await onCopy(fixture.tmp, owner, (client) =>
      applyRemote(
        client,
        own.filter((change) => change.txn_id === first)
      )
    );
    expect(released.data).toMatchObject({ folded: 1, notes: [] });
    expect(released.data!.newlyLive).toContain(first);
    expect(context(owner, 'master_context').next_session_context.when_we_resume).toContain(
      `${sessionId}: Wire the relay once it ships.`
    );
  }, 120000);

  it("this copy's sprint pointers follow a sprint another copy opened and closed", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const tracking = (copy: Copy) => context(copy, 'master_context').sprint_tracking ?? null;
    await ok(owner, 'rbook_sprint', {
      action: 'add',
      sprintId: 't-sprint-1',
      title: 'T',
      status: 'Active',
    });
    await sync(fixture.tmp, owner, member);
    expect(tracking(member)?.current_sprint?.id).toBe('t-sprint-1');
    await ok(owner, 'rbook_sprint', {
      action: 'update',
      sprintId: 't-sprint-1',
      fields: { status: 'Completed' },
    });
    const report = await sync(fixture.tmp, owner, member);
    expect(report.notes).toEqual([]);
    expect(tracking(member)).toMatchObject({
      current_sprint: null,
      last_completed_sprint: 't-sprint-1',
    });
    expect(tracking(member)).toEqual(tracking(owner));
  }, 120000);

  it('with a sprint opened on each copy, every copy points at the one the record created last', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const tracking = (copy: Copy) => context(copy, 'master_context').sprint_tracking ?? null;
    await ok(owner, 'rbook_sprint', {
      action: 'add',
      sprintId: 'o-sprint',
      title: 'O',
      status: 'Active',
    });
    await ok(member, 'rbook_sprint', {
      action: 'add',
      sprintId: 'm-sprint',
      title: 'M',
      status: 'Active',
    });
    for (let round = 0; round < 2; round++) await exchange(fixture.tmp, owner, member);
    // Each copy inserted the other's sprint last, so by its own insertion each would name the other's.
    const [latest] = read(
      owner,
      `SELECT s.id FROM record_changes k JOIN sprints s ON s.stable_event_id = k.entity_id
        WHERE k.kind = 'create' AND k.entity = 'sprints' ORDER BY k.hlc DESC, k.change_id DESC LIMIT 1`
    ) as Array<{ id: string }>;
    expect(['o-sprint', 'm-sprint']).toContain(latest.id);
    expect(tracking(owner)?.current_sprint?.id).toBe(latest.id);
    expect(tracking(member)).toEqual(tracking(owner));
  }, 120000);

  it('two sprints created at one clock reading, one on each copy, leave every copy pointing at the same one', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const tracking = (copy: Copy) => context(copy, 'master_context').sprint_tracking ?? null;
    // Both clocks an hour ahead at one reading, so both creates read the same hlc (the surfaces critic).
    const ahead = `${String(Date.now() + 3_600_000).padStart(13, '0')}-000005`;
    for (const copy of [owner, member]) {
      const db = new Database(dbOf(copy.root));
      try {
        db.prepare("UPDATE metadata SET value = ? WHERE key = 'replica_hlc'").run(ahead);
      } finally {
        db.close();
      }
    }
    await ok(owner, 'rbook_sprint', {
      action: 'add',
      sprintId: 'o-sprint',
      title: 'O',
      status: 'Active',
    });
    await ok(member, 'rbook_sprint', {
      action: 'add',
      sprintId: 'm-sprint',
      title: 'M',
      status: 'Active',
    });
    for (let round = 0; round < 2; round++) await exchange(fixture.tmp, owner, member);
    const creates = read(
      owner,
      `SELECT s.id, k.hlc FROM record_changes k JOIN sprints s ON s.stable_event_id = k.entity_id
        WHERE k.kind = 'create' AND k.entity = 'sprints' ORDER BY k.hlc DESC, k.change_id DESC`
    ) as Array<{ id: string; hlc: string }>;
    expect(new Set(creates.map((create) => create.hlc)).size).toBe(1);
    expect(tracking(owner)?.current_sprint?.id).toBe(creates[0].id);
    expect(tracking(member)).toEqual(tracking(owner));
  }, 120000);

  it("a session open on the owner's copy since before sharing stays the owner's on a member's copy", async () => {
    useMachine(fixture.tmp, 'machine-owner');
    const root = project(fixture.tmp, 'owner');
    const sessionId = (
      await call('rbook_session', {
        action: 'start',
        type: 'planning',
        title: 'Open before sharing',
        projectRoot: root,
      })
    ).data!.sessionId!;
    writeUserAuthor('Owner');
    const replicaId = await onCopy(
      fixture.tmp,
      { root, machine: 'machine-owner' },
      (client) => {
        const readiness = prepareForSharing(client);
        if (!readiness.ready) throw new Error(readiness.problems.join(' '));
        return shareRecord(client).replicaId;
      },
      { replicaCheck: false }
    );
    const owner: Copy = { name: 'owner', root, machine: 'machine-owner', replicaId, block: 0 };
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    // The baseline holds it, so its creator is the authority.
    expect(
      read(member, 'SELECT owner_key, implicit FROM sessions WHERE id = ?', [sessionId])
    ).toEqual([{ owner_key: `peer:${owner.replicaId}`, implicit: 0 }]);
    // The member's own capture lands in a session of its own, never the owner's.
    await ok(member, 'rbook_session', {
      action: 'capture',
      category: 'context',
      content: 'Written on the member.',
    });
    expect(
      read<{ captures: string }>(member, 'SELECT captures FROM sessions WHERE id = ?', [
        sessionId,
      ])[0].captures
    ).not.toContain('Written on the member.');
    const day = Date.now() + 24 * 60 * 60 * 1000;
    await onCopy(fixture.tmp, member, (client) => {
      expect(explicitSessionsAtStart(client, day)!.idle.map((row) => row.sessionId)).not.toContain(
        sessionId
      );
      expect(implicitSessionsToClose(client, day)!.map((row) => row.sessionId)).not.toContain(
        sessionId
      );
    });
    // When the owner closes it, the member's resume note and working memory take it in.
    await ok(owner, 'rbook_session', { action: 'complete', summary: 'Closed on the owner.' });
    expect((await sync(fixture.tmp, owner, member)).folded).toBe(1);
  }, 120000);

  it('a copy that re-identifies, once or twice, keeps the sessions its earlier identities started', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const sessionId = (
      await ok(owner, 'rbook_session', {
        action: 'start',
        type: 'planning',
        title: 'Open at re-identify',
      })
    ).data!.sessionId!;
    const before = read(owner, 'SELECT owner_key FROM sessions WHERE id = ?', [sessionId]);
    // The second time, the session's creator is neither the copy's identity nor its previous one.
    for (const block of [5, 6]) {
      await onCopy(
        fixture.tmp,
        owner,
        (client) => reidentifyReplica(client, { block, authorityReceived: null }),
        { replicaCheck: false }
      );
      expect(read(owner, 'SELECT owner_key FROM sessions WHERE id = ?', [sessionId])).toEqual(
        before
      );
    }
    expect(
      (
        await ok(owner, 'rbook_session', {
          action: 'complete',
          summary: 'Closed after re-identifying.',
        })
      ).success
    ).toBe(true);
  }, 120000);

  it("a session the owner opened after sharing is the owner's on a member's copy made later", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const sessionId = (
      await ok(owner, 'rbook_session', {
        action: 'start',
        type: 'planning',
        title: 'Open after sharing',
      })
    ).data!.sessionId!;
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    expect(
      read(member, 'SELECT owner_key, implicit FROM sessions WHERE id = ?', [sessionId])
    ).toEqual([{ owner_key: `peer:${owner.replicaId}`, implicit: 0 }]);
    // On the owner's own copy it stays the owner's.
    expect(read(owner, 'SELECT owner_key FROM sessions WHERE id = ?', [sessionId])).not.toEqual([
      { owner_key: `peer:${owner.replicaId}` },
    ]);
  }, 120000);

  it("a session the other copy started is not this copy's to write to, close or close as idle", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const sessionId = await memberSession(member, false);
    await sync(fixture.tmp, member, owner);
    expect(
      read<{ owner_key: string; implicit: number }>(
        owner,
        'SELECT owner_key, implicit FROM sessions WHERE id = ?',
        [sessionId]
      )
    ).toEqual([{ owner_key: `peer:${member.replicaId}`, implicit: 0 }]);
    for (const args of [
      { action: 'complete', sessionId, summary: 'Closed from the wrong copy.' },
      {
        action: 'capture',
        sessionId,
        category: 'context',
        content: 'Written from the wrong copy.',
      },
    ]) {
      useMachine(fixture.tmp, owner.machine);
      const refused = await call('rbook_session', { ...args, projectRoot: owner.root });
      expect(refused.error).toMatchObject({
        message: expect.stringMatching(/belongs to another copy of this shared record/),
        suggestion: 'Leave sessionId out to use a session on this copy.',
      });
    }
    expect(read(owner, 'SELECT status FROM sessions WHERE id = ?', [sessionId])).toEqual([
      { status: 'active' },
    ]);
    // A day later it is idle by this copy's clock, and still not this copy's to close.
    const atStart = await onCopy(fixture.tmp, owner, (client) =>
      explicitSessionsAtStart(client, Date.now() + 24 * 60 * 60 * 1000)
    );
    expect(atStart!.idle.map((session) => session.sessionId)).not.toContain(sessionId);
  }, 120000);
});

describe('citations and embeddings after a merge', () => {
  it("the receiving copy links a merged decision's citation, which resolves by id alone", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const first = (
      await ok(owner, 'rbook_decisions', { action: 'record', content: 'Use one ledger.' })
    ).data!.decisionId!;
    await sync(fixture.tmp, owner, member);
    const second = (
      await ok(member, 'rbook_decisions', {
        action: 'record',
        content: `Keep d:${first}'s ledger in one file.`,
      })
    ).data!.decisionId!;
    const report = await sync(fixture.tmp, member, owner);
    expect(report.notes).toEqual([]);
    expect(
      read(owner, 'SELECT to_kind, to_id FROM record_links WHERE from_kind = ? AND from_id = ?', [
        'decision',
        second,
      ])
    ).toEqual([{ to_kind: 'decision', to_id: first }]);
    expect(await onCopy(fixture.tmp, owner, (client) => loadLinkInventory(client).byIdAlone)).toBe(
      true
    );
    useMachine(fixture.tmp, 'solo-machine');
    const solo = project(fixture.tmp, 'solo');
    expect(await withClient(solo, (client) => loadLinkInventory(client).byIdAlone)).toBe(false);
  }, 120000);

  it('a citation of a row whose clock ran ahead, or whose time is unreadable, links on a shared record, and not on a solo one', async () => {
    const ahead = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    // The two halves of resolving by id alone: a cited row's own time, read early, covers an
    // unreadable one; a citing row's, read late, covers a cited row whose clock ran ahead.
    const linked = async (root: string, machine: string, recorded: boolean, citedAt: string) => {
      useMachine(fixture.tmp, machine);
      const decide = async (content: string) =>
        (await call('rbook_decisions', { action: 'record', content, projectRoot: root })).data!
          .decisionId!;
      const cited = await decide('Use one ledger.');
      const citing = await decide(`Keep d:${cited}.`);
      await withClient(
        root,
        (client) => {
          const sql = 'UPDATE strategic_decisions SET created_at = ? WHERE id = ?';
          const moved = recorded
            ? recordedExecute(client, sql, [citedAt, cited])
            : client.execute(sql, [citedAt, cited]);
          if (!moved.success) throw new Error(moved.error?.message);
          const repaired = repairRecordLinksBatch(client, [{ kind: 'decision', id: citing }]);
          if (!repaired.success) throw new Error(repaired.error?.message);
        },
        { replicaCheck: false }
      );
      return read({ root }, 'SELECT to_id FROM record_links WHERE from_kind = ? AND from_id = ?', [
        'decision',
        citing,
      ]).map((row) => (row as { to_id: number }).to_id);
    };
    const owner = await ownerCopy(fixture.tmp);
    const solo = project(fixture.tmp, 'solo');
    for (const citedAt of [ahead, 'not a time']) {
      expect({
        citedAt,
        links: (await linked(owner.root, owner.machine, true, citedAt)).length,
      }).toEqual({ citedAt, links: 1 });
      expect({ citedAt, links: await linked(solo, 'solo-machine', false, citedAt) }).toEqual({
        citedAt,
        links: [],
      });
    }
  }, 60000);

  it('a decision that cites itself links to nothing on a shared copy, as on a solo store', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const id = (await ok(owner, 'rbook_decisions', { action: 'record', content: 'Placeholder.' }))
      .data!.decisionId!;
    await withClient(
      owner.root,
      (client) => {
        const cited = recordedExecute(
          client,
          'UPDATE strategic_decisions SET decision_text = ? WHERE id = ?',
          [`Keep d:${id} as written.`, id]
        );
        if (!cited.success) throw new Error(cited.error?.message);
        const repaired = repairRecordLinksBatch(client, [{ kind: 'decision', id }]);
        if (!repaired.success) throw new Error(repaired.error?.message);
      },
      { replicaCheck: false }
    );
    expect(read(owner, 'SELECT * FROM record_links WHERE from_id = ?', [id])).toEqual([]);
  }, 60000);

  it('each merged decision, learning and mission is offered to the embedder with its current text', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const decision = (
      await ok(member, 'rbook_decisions', { action: 'record', content: 'Embed the peer choice.' })
    ).data!.decisionId!;
    await ok(member, 'rbook_session', {
      action: 'capture',
      category: 'learning',
      content: 'A peer lesson to embed.',
    });
    await ok(member, 'rbook_mission', { action: 'add', missionId: 'e-m01', name: 'Peer mission' });
    await sync(fixture.tmp, member, owner);
    const changes = await onCopy(fixture.tmp, member, (client) => changesSince(client, {}));
    const embed = jest.mocked(recordEmbedding);
    embed.mockClear();
    const result = await onCopy(fixture.tmp, owner, (client) => embedMergedRows(client, changes));
    const offered = embed.mock.calls.map(([, target]) => target);
    expect(offered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'decision',
          id: decision,
          inputText: expect.stringContaining('Embed the peer choice.'),
        }),
        expect.objectContaining({
          type: 'learning',
          inputText: expect.stringContaining('A peer lesson to embed.'),
        }),
        expect.objectContaining({
          type: 'mission',
          id: 'e-m01',
          inputText: expect.stringContaining('Peer mission'),
        }),
      ])
    );
    expect(result.embedded).toBe(offered.length);
  }, 120000);
});
