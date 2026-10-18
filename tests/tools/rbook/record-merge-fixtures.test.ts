// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m12's standing fixtures (practice 4): a store that is not a copy, another project's record, a NULL value,
// ABOUTME: tables made after the merge, an explicit root with nothing in the environment, and this repo's own store.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { keywordRelevant } from '../../../src/cli/commands';
import { admitMember, applyRemote, changesSince } from '../../../src/tools/rbook/record-apply';
import { recordedExecute } from '../../../src/tools/rbook/record-changes';
import { crossRecordFindings } from '../../../src/tools/rbook/record-checks';
import { formatSettleForLLM } from '../../../src/tools/rbook/rbook-db-conflicts';
import { shareRecord } from '../../../src/tools/rbook/record-share';
import { prepareForSharing } from '../../../src/tools/rbook/sharing-preconditions';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  withClient,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { seedRbookDb, reidentifyRbookTestStore } from '../../helpers/seedRbookDb';
import {
  exchange,
  memberCopy,
  onCopy,
  ownerCopy,
  read,
  sync,
  type Copy,
} from '../../helpers/shared-copies';

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The real-store merge shares a copy of this repository's own store, taken from its git history; the public mirror carries neither.",
  revisions: { release: 'v4.0.2' },
});

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-merge-fixtures-');
});
afterEach(() => fixture.restore());

async function ok(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

/** The owner's copy of a store already at `root`, shared on its own machine as ownerCopy does. */
async function shareAt(root: string, name: string): Promise<Copy> {
  const machine = `machine-${name}`;
  useMachine(fixture.tmp, machine);
  writeUserAuthor('Owner');
  const replicaId = await onCopy(
    fixture.tmp,
    { root, machine },
    (client) => {
      const readiness = prepareForSharing(client);
      if (!readiness.ready) throw new Error(readiness.problems.join(' '));
      return shareRecord(client).replicaId;
    },
    { replicaCheck: false }
  );
  return { name, root, machine, replicaId, block: 0 };
}

describe('the merge on stores it was not made for', () => {
  it('a store that is not a copy of a shared record refuses to merge, and says what to do', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await ok(member, 'rbook_decisions', { action: 'record', content: 'A change to send.' });
    const changes = await onCopy(fixture.tmp, member, (client) => changesSince(client, {}));
    useMachine(fixture.tmp, 'solo-machine');
    const solo = project(fixture.tmp, 'solo');
    const refused = await withClient(solo, (client) => applyRemote(client, changes));
    expect(refused).toMatchObject({
      success: false,
      error: {
        code: 'RECORD_WRITE_REFUSED',
        suggestion: 'Share the project, or join it, before syncing.',
      },
    });
    expect(
      read({ root: solo }, "SELECT name FROM sqlite_master WHERE name = 'record_changes'")
    ).toEqual([]);
  }, 60000);

  it("another project's record is refused whole, and nothing of it is stored", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const otherRoot = path.join(fixture.tmp, 'other');
    seedRbookDb(otherRoot, { projectId: 'p-other', projectName: 'other' });
    const other = await shareAt(otherRoot, 'other');
    await ok(other, 'rbook_decisions', { action: 'record', content: 'Not this project.' });
    const foreign = await onCopy(fixture.tmp, other, (client) => changesSince(client, {}));
    const before = read(owner, 'SELECT count(*) AS n FROM record_changes');
    const refused = await onCopy(fixture.tmp, owner, (client) => applyRemote(client, foreign));
    expect(refused.error).toMatchObject({
      code: 'RECORD_WRITE_REFUSED',
      message: expect.stringMatching(/holds changes of project p-other.*project p-shared/),
    });
    expect(read(owner, 'SELECT count(*) AS n FROM record_changes')).toEqual(before);
  }, 60000);

  it('an author name no copy of Reasonbook records is refused whole, on the change or in its row', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await ok(member, 'rbook_decisions', { action: 'record', content: 'Signed by its author.' });
    const sent = await onCopy(fixture.tmp, member, (client) => changesSince(client, {}));
    const create = sent.find(
      (change) => change.kind === 'create' && change.entity === 'strategic_decisions'
    )!;
    // A right-to-left override, a bell, and a name the rule would trim: no copy stamps any of them.
    const override = `Mem${String.fromCodePoint(0x202e)}ber`;
    const bell = `Member${String.fromCodePoint(7)}`;
    const tamper = (edit: Partial<typeof create>) =>
      sent.map((change) =>
        change.change_id === create.change_id ? { ...change, ...edit } : change
      );
    const before = read(owner, 'SELECT count(*) AS n FROM record_changes');
    for (const delivery of [
      tamper({ author_name: override }),
      tamper({ author_name: ' Member' }),
      tamper({ value: JSON.stringify({ ...JSON.parse(create.value!), author_name: bell }) }),
    ]) {
      const refused = await onCopy(fixture.tmp, owner, (client) => applyRemote(client, delivery));
      expect(refused.error).toMatchObject({
        code: 'RECORD_WRITE_REFUSED',
        message: expect.stringMatching(/author name no copy of Reasonbook records/),
      });
      expect(read(owner, 'SELECT count(*) AS n FROM record_changes')).toEqual(before);
    }
    // The delivery as the member's copy wrote it applies.
    expect((await onCopy(fixture.tmp, owner, (client) => applyRemote(client, sent))).success).toBe(
      true
    );
  }, 60000);
});

describe('links whose missions are not live here', () => {
  it("wait, without failing the merge, until the owner's verdicts make them live", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const a = await memberCopy(fixture.tmp, owner, 'a', 1);
    const b = await memberCopy(fixture.tmp, owner, 'b', 2);
    for (const [missionId, name] of [
      ['p-m01', 'P'],
      ['p-m02', 'Q'],
    ])
      await ok(a, 'rbook_mission', { action: 'add', missionId, name });
    await ok(a, 'rbook_mission', { action: 'depends', fromId: 'p-m01', toId: 'p-m02' });
    // A's data before the owner judged it: its creates wait for verdicts, and the link waits for them.
    const own = (await onCopy(fixture.tmp, a, (client) => changesSince(client, {}))).filter(
      (change) => change.replica_id === a.replicaId
    );
    const early = await onCopy(fixture.tmp, b, (client) => applyRemote(client, own));
    expect(early.success).toBe(true);
    expect(read(b, "SELECT * FROM mission_dependencies WHERE from_id = 'p-m01'")).toEqual([]);
    await sync(fixture.tmp, a, owner);
    await sync(fixture.tmp, owner, b);
    expect(
      read(b, "SELECT from_id, to_id FROM mission_dependencies WHERE from_id = 'p-m01'")
    ).toEqual([{ from_id: 'p-m01', to_id: 'p-m02' }]);
  }, 120000);

  it("an outsider's link is refused with its creates, and the owner's merge does not fail", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const outsider = await memberCopy(fixture.tmp, owner, 'outsider', 7, { admit: false });
    for (const [missionId, name] of [
      ['o-m01', 'P'],
      ['o-m02', 'Q'],
    ])
      await ok(outsider, 'rbook_mission', { action: 'add', missionId, name });
    await ok(outsider, 'rbook_mission', { action: 'depends', fromId: 'o-m01', toId: 'o-m02' });
    const report = await sync(fixture.tmp, outsider, owner);
    expect(report.judged).toBe(3);
    expect(read(owner, "SELECT id FROM missions WHERE id LIKE 'o-m0%'")).toEqual([]);
    expect(read(owner, 'SELECT state FROM record_txn_state ORDER BY state')).toEqual([
      { state: 'refused' },
      { state: 'refused' },
      { state: 'refused' },
    ]);
  }, 120000);
});

describe("the merge's refusals and their remedies", () => {
  it('a slot that holds a different change stops the exchange and names the remedy', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await ok(member, 'rbook_decisions', { action: 'record', content: 'The member wrote this.' });
    await sync(fixture.tmp, member, owner);
    const [sent] = await onCopy(fixture.tmp, member, (client) =>
      changesSince(client, {}).filter((change) => change.replica_id === member.replicaId)
    );
    const refused = await onCopy(fixture.tmp, owner, (client) =>
      applyRemote(client, [{ ...sent, change_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' }])
    );
    expect(refused.error).toMatchObject({
      code: 'RECORD_SLOT_CLASH',
      suggestion: expect.stringMatching(/re-identifies into a fresh block/),
    });
  }, 60000);

  it("only the owner's copy admits a member", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const refused = await onCopy(fixture.tmp, member, (client) =>
      admitMember(client, { replicaId: 'someone', block: 5, role: 'editor' })
    );
    expect(refused.error).toMatchObject({
      code: 'RECORD_WRITE_REFUSED',
      suggestion: "Admit the member from the owner's copy.",
    });
  }, 60000);

  it('a settle keeps one of the values copies wrote, and refuses any other, naming them', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const id = (await ok(owner, 'rbook_decisions', { action: 'record', content: 'Argued.' })).data!
      .decisionId!;
    await sync(fixture.tmp, owner, member);
    await ok(owner, 'rbook_decisions', { action: 'update', decisionId: id, status: 'archived' });
    await ok(member, 'rbook_decisions', { action: 'update', decisionId: id, status: 'stale' });
    await exchange(fixture.tmp, owner, member);
    const settle = (value: unknown) => {
      useMachine(fixture.tmp, member.machine);
      return call('rbook_db', {
        action: 'settle',
        table: 'strategic_decisions',
        recordId: String(id),
        field: 'status',
        value,
        projectRoot: member.root,
      });
    };
    for (const value of ['bogus', 'Archived'])
      expect((await settle(value)).error).toMatchObject({
        code: 'RECORD_WRITE_REFUSED',
        suggestion: expect.stringMatching(/Keep one of the values/),
        validValues: expect.arrayContaining(['"archived"', '"stale"']),
      });
    // The text answer lists them too, as JSON, so a reader who sent a string for a number sees it.
    const refused = (await settle('bogus')) as unknown as Parameters<typeof formatSettleForLLM>[0];
    expect(formatSettleForLLM(refused)).toMatch(/^Valid values: (?=.*"archived")(?=.*"stale")/m);
    expect(read(member, 'SELECT status FROM strategic_decisions WHERE id = ?', [id])).not.toEqual([
      { status: 'bogus' },
    ]);
    expect((await settle('stale')).success).toBe(true);
  }, 60000);

  it('a settle names a table that can conflict, a field in conflict, and a lineage fork on the owner', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const old = (await ok(owner, 'rbook_decisions', { action: 'record', content: 'Old way.' }))
      .data!.decisionId!;
    await sync(fixture.tmp, owner, member);
    await ok(owner, 'rbook_decisions', { action: 'record', content: 'Ours.', supersedes: [old] });
    await ok(member, 'rbook_decisions', {
      action: 'record',
      content: 'Theirs.',
      supersedes: [old],
    });
    await exchange(fixture.tmp, owner, member);
    await sync(fixture.tmp, owner, member);
    const settle = async (copy: Copy, args: Record<string, unknown>) => {
      useMachine(fixture.tmp, copy.machine);
      return call('rbook_db', { action: 'settle', ...args, projectRoot: copy.root });
    };
    expect(
      (await settle(member, { table: 'session_missions', recordId: '1', field: 'x', value: 1 }))
        .error
    ).toMatchObject({ suggestion: expect.stringMatching(/Name one of the tables/) });
    expect(
      (
        await settle(member, {
          table: 'strategic_decisions',
          recordId: String(old),
          field: 'category',
          value: 'x',
        })
      ).error
    ).toMatchObject({ suggestion: expect.stringMatching(/Write the field as usual/) });
    const lineage = { table: 'strategic_decisions', recordId: String(old), field: 'superseded_by' };
    const [kept] = read<{ superseded_by: number }>(
      owner,
      'SELECT superseded_by FROM strategic_decisions WHERE id = ?',
      [old]
    );
    expect((await settle(member, { ...lineage, value: kept.superseded_by })).error).toMatchObject({
      suggestion: "Ask the owner to settle it from the owner's copy.",
    });
    expect((await settle(owner, { ...lineage, value: kept.superseded_by })).success).toBe(true);
  }, 60000);
});

describe('values and tables at the edges', () => {
  it('a field set to NULL on one copy is NULL on the other, with one head', async () => {
    const owner = await ownerCopy(fixture.tmp);
    await ok(owner, 'rbook_mission', {
      action: 'add',
      missionId: 'n-m01',
      name: 'Has an objective',
      objective: 'Something to clear.',
    });
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await onCopy(fixture.tmp, member, (client) => {
      const cleared = recordedExecute(client, 'UPDATE missions SET objective = NULL WHERE id = ?', [
        'n-m01',
      ]);
      if (!cleared.success) throw new Error(cleared.error?.message);
    });
    await exchange(fixture.tmp, owner, member);
    for (const copy of [owner, member])
      expect(read(copy, "SELECT objective FROM missions WHERE id = 'n-m01'")).toEqual([
        { objective: null },
      ]);
    expect(
      read(
        owner,
        "SELECT count(*) AS n FROM record_heads WHERE entity = 'missions' AND field = 'objective'"
      )
    ).toEqual([{ n: 1 }]);
  }, 60000);

  it('the contexts a merge folds a session into are made when this copy has none yet', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await onCopy(fixture.tmp, owner, (client) =>
      client.execute("DELETE FROM contexts WHERE id IN ('project_context', 'master_context')")
    );
    const started = await ok(member, 'rbook_session', {
      action: 'start',
      type: 'planning',
      title: 'Closed on the member',
    });
    await ok(member, 'rbook_session', { action: 'complete', summary: 'Done there.' });
    const report = await sync(fixture.tmp, member, owner);
    expect(report).toMatchObject({ folded: 1, notes: [] });
    const history = JSON.parse(
      read<{ content: string }>(
        owner,
        "SELECT content FROM contexts WHERE id = 'project_context'"
      )[0].content
    ).working_memory.session_history as Array<{ session: string }>;
    expect(history.map((entry) => entry.session)).toEqual([started.data!.sessionId]);
  }, 60000);

  it('a citation table this copy makes after the merge links what the merge brought, by id', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    // The owner's copy has no link table yet, as a store that has never linked a citation.
    await onCopy(fixture.tmp, owner, (client) => {
      for (const sql of [
        'DROP TABLE record_links',
        "DELETE FROM metadata WHERE key = 'record_links_schema'",
      ]) {
        const done = client.execute(sql);
        if (!done.success) throw new Error(done.error?.message);
      }
    });
    expect(read(owner, "SELECT name FROM sqlite_master WHERE name = 'record_links'")).toEqual([]);
    const first = (await ok(member, 'rbook_decisions', { action: 'record', content: 'First.' }))
      .data!.decisionId!;
    const second = (
      await ok(member, 'rbook_decisions', { action: 'record', content: `Keep d:${first}.` })
    ).data!.decisionId!;
    expect((await sync(fixture.tmp, member, owner)).notes).toEqual([]);
    // The owner's first own write makes its link table, which links every source it holds.
    await ok(owner, 'rbook_decisions', { action: 'record', content: 'The owner writes.' });
    expect(
      read(owner, 'SELECT to_id FROM record_links WHERE from_kind = ? AND from_id = ?', [
        'decision',
        second,
      ])
    ).toEqual([{ to_id: first }]);
  }, 60000);

  it('rbook_db answers from the copy its explicit projectRoot names, with nothing in the environment', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const id = (await ok(owner, 'rbook_decisions', { action: 'record', content: 'Argued.' })).data!
      .decisionId!;
    await sync(fixture.tmp, owner, member);
    await ok(owner, 'rbook_decisions', { action: 'update', decisionId: id, status: 'archived' });
    await ok(member, 'rbook_decisions', { action: 'update', decisionId: id, status: 'stale' });
    await exchange(fixture.tmp, owner, member);
    for (const name of ['RBOOK_PROJECT_ROOT', 'CLAUDE_PROJECT_DIR']) delete process.env[name];
    // The working directory is this repository, whose own store is not shared.
    expect(process.cwd()).not.toBe(member.root);
    const listed = await ok(member, 'rbook_db', { action: 'conflicts' });
    expect((listed.data as { count: number }).count).toBe(1);
  }, 60000);
});

PRIVATE.describe("the merge on a copy of this repository's own store", () => {
  it('fires a field conflict, a cross-record check, the answer notice and the relevant mark', async () => {
    const root = path.join(fixture.tmp, 'real');
    fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
    fs.writeFileSync(
      dbOf(root),
      execFileSync('git', ['show', `${PRIVATE.revisions.release}:rbook/db/rbook.sqlite`], {
        cwd: path.resolve(__dirname, '..', '..', '..'),
        maxBuffer: 256 * 1024 * 1024,
      })
    );
    reidentifyRbookTestStore(root);
    const owner = await shareAt(root, 'real-owner');
    const member = await memberCopy(fixture.tmp, owner, 'real-member', 1);
    // A real decision, and the words `reasonbook relevant` finds it by. The first prompt's recall
    // keeps to this copy's project id, which the re-identified copy's old rows do not carry.
    const [decision] = read<{ id: number; decision_text: string; status: string }>(
      owner,
      "SELECT id, decision_text, status FROM strategic_decisions WHERE status IN ('active', 'archived') AND length(decision_text) > 60 ORDER BY id DESC LIMIT 1"
    );
    const query = decision.decision_text.split(/\s+/).slice(0, 10).join(' ');
    expect(keywordRelevant(dbOf(owner.root), query, 20).map((item) => item.id)).toContain(
      decision.id
    );
    const [ours, theirs] = ['active', 'archived', 'stale'].filter(
      (value) => value !== decision.status
    );
    await ok(owner, 'rbook_decisions', { action: 'update', decisionId: decision.id, status: ours });
    await ok(member, 'rbook_decisions', {
      action: 'update',
      decisionId: decision.id,
      status: theirs,
    });
    for (const [copy, sprintId] of [
      [owner, 'sprint-902'],
      [member, 'sprint-901'],
    ] as const)
      await ok(copy, 'rbook_sprint', {
        action: 'add',
        sprintId,
        title: sprintId,
        status: 'Active',
      });
    await exchange(fixture.tmp, owner, member);
    await sync(fixture.tmp, owner, member);
    for (const copy of [owner, member]) {
      expect(read(copy, 'SELECT entity, field FROM record_conflicts')).toEqual([
        { entity: 'strategic_decisions', field: 'status' },
      ]);
      const findings = await onCopy(fixture.tmp, copy, (client) => crossRecordFindings(client));
      expect(findings).toEqual([
        expect.objectContaining({ check: 'two_open_sprints', subject: 'sprint-901,sprint-902' }),
      ]);
    }
    const answer = (await ok(member, 'rbook_mission', { action: 'status' })) as {
      warnings?: string[];
    };
    expect(JSON.stringify(answer.warnings ?? [])).toMatch(
      new RegExp(`strategic_decisions ${decision.id}'s status shows`)
    );
    const marked = keywordRelevant(dbOf(member.root), query, 20);
    expect(marked.find((item) => item.id === decision.id)?.conflicts).toEqual(['status']);
  }, 600000);
});
