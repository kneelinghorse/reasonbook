// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m12 (design item 6, ADR s96 §5) — the review of a shared copy names its conflicts, states, changes not
// ABOUTME: live, who started each mission and other authors; recall marks a provisional value; a solo store is unchanged.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { keywordRelevant } from '../../../src/cli/commands';
import { recallLaterPrompt } from '../../../src/cli/later-prompt-recall';
import { HOOK_CAPS } from '../../../src/cli/core';
import { MIN_RECALL_ROOM, renderFirstPrompt } from '../../../src/cli/prompt';
import { RECORD_COLUMNS } from '../../../src/tools/rbook/record-columns';
import { CONFLICT_POINTER } from '../../../src/tools/rbook/record-conflict-marks';
import {
  DIGEST_V2_CAP,
  renderDigestV2,
  type DigestV2Model,
} from '../../../src/tools/rbook/digest-v2';
import { readDigestV2 } from '../../../src/tools/rbook/digest-v2-store';
import { recallFirstPrompt } from '../../../src/tools/rbook/first-prompt-recall';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import {
  exchange,
  memberCopy,
  ownerCopy,
  sync,
  syncCopies,
  type Copy,
} from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-review-');
});
afterEach(() => fixture.restore());

async function ok(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

async function digestOf(copy: { root: string; machine: string }): Promise<string> {
  useMachine(fixture.tmp, copy.machine);
  return renderDigestV2(await readDigestV2(copy.root)).text;
}

/** The owner's copy and a member's, with a decision whose status the two changed concurrently. */
async function contested() {
  const owner = await ownerCopy(fixture.tmp);
  const member = await memberCopy(fixture.tmp, owner, 'member', 1);
  const made = await ok(owner, 'rbook_decisions', {
    action: 'record',
    content: 'Keep the ledger in one place.',
  });
  const id = made.data!.decisionId!;
  await sync(fixture.tmp, owner, member);
  await ok(owner, 'rbook_decisions', { action: 'update', decisionId: id, status: 'archived' });
  await ok(member, 'rbook_decisions', { action: 'update', decisionId: id, status: 'stale' });
  await exchange(fixture.tmp, owner, member);
  await sync(fixture.tmp, owner, member);
  return { owner, member, id };
}

describe("the review of a shared copy (rbook_review's digest, the session-start hook, reasonbook review)", () => {
  it('names its conflicts, the states its checks find, changes not live, who started each mission, and other authors', async () => {
    const { owner, member, id } = await contested();
    const outsider = await memberCopy(fixture.tmp, owner, 'outsider', 7, { admit: false });
    await ok(outsider, 'rbook_decisions', { action: 'record', content: 'An outsider says.' });
    await sync(fixture.tmp, outsider, owner);
    await ok(member, 'rbook_mission', { action: 'add', missionId: 'r-m01', name: 'Theirs' });
    await ok(member, 'rbook_mission_transition', { action: 'start', missionId: 'r-m01' });
    await ok(member, 'rbook_decisions', { action: 'record', content: 'The member chose this.' });
    for (const sprintId of ['r-sprint-1', 'r-sprint-2'])
      await ok(sprintId.endsWith('1') ? owner : member, 'rbook_sprint', {
        action: 'add',
        sprintId,
        title: sprintId,
        status: 'Active',
      });
    await exchange(fixture.tmp, owner, member);
    await sync(fixture.tmp, owner, member);
    // Row-transfer helpers do not report readers; a real handshake identifies this current copy.
    await syncCopies(fixture.tmp, member, owner);
    useMachine(fixture.tmp, owner.machine);
    const model = await readDigestV2(owner.root);
    const text = renderDigestV2(model).text;
    expect(text).toContain('Shared record:');
    // Protocol and sync notices put this fixture over the 600-character shared-section cap.
    // The short digest keeps counts and the lookup; the structured review retains every detail.
    expect(text).toContain('1 field(s) in conflict');
    expect(text).toContain('1 state(s) need a person');
    expect(text).toContain('2 change(s) not live yet (2 refused)');
    expect(text).toContain('rbook_db(action="conflicts")');
    expect(model.shared?.protocol?.stranded).toEqual([]);
    expect(model.shared?.conflicts).toContain(`strategic_decisions ${id}'s status (2 values)`);
    expect(model.shared?.states.join(' ')).toMatch(/r-sprint-1 and r-sprint-2 are all open/);
    expect(model.shared?.waiting.join(' ')).toMatch(
      /\d+ refused by the owner's copy, so never applied \((the first )?an outsider's copy is not a member of this shared record\)/
    );
    expect(model.shared?.started).toContain('r-m01, started by member');
    expect(text).toMatch(/d:\d+ \d{4}-\d{2}-\d{2} \(member\) The member chose this\./);
    // This copy's own writer is not named on its own rows.
    expect(text).not.toMatch(/\(Owner\)/);
    expect(text.length).toBeLessThanOrEqual(DIGEST_V2_CAP);
    // The MCP review says it in its digest, not again in its warnings.
    useMachine(fixture.tmp, owner.machine);
    const review = (await call('rbook_review', { projectRoot: owner.root })) as {
      warnings?: string[];
    };
    expect(JSON.stringify(review.warnings ?? [])).not.toMatch(/hold values from copies/);
  }, 120000);

  it('a solo store has no shared-record section and names no authors', async () => {
    useMachine(fixture.tmp, 'solo-machine');
    const solo = project(fixture.tmp, 'solo');
    await call('rbook_decisions', {
      action: 'record',
      content: 'A solo choice.',
      projectRoot: solo,
    });
    const text = await digestOf({ root: solo, machine: 'solo-machine' });
    expect(text).not.toContain('Shared record');
    expect(text).toMatch(/d:\d+ \d{4}-\d{2}-\d{2} A solo choice\./);
  }, 60000);

  it('points at rbook_db conflicts only when there is a conflict or a state to settle there', () => {
    const base: DigestV2Model = {
      project: { name: 'P', level: 'builder' },
      localProjectId: null,
      sprint: null,
      profile: null,
      stepUp: null,
      rules: [],
      decisions: { rows: [], total: 0 },
      learnings: { rows: [], total: 0 },
      work: [],
    };
    const waitingOnly = renderDigestV2({
      ...base,
      shared: {
        conflicts: [],
        states: [],
        waiting: ['1 held until what they wait for arrives, which a sync brings (...)'],
        waitingTotal: 1,
        started: ['m-1, started by someone'],
      },
    }).text;
    expect(waitingOnly).toContain('Changes not live: 1 held');
    expect(waitingOnly).not.toContain('rbook_db(action="conflicts")');
    const withConflict = renderDigestV2({
      ...base,
      shared: {
        conflicts: ["missions m-1's objective (2 values)"],
        states: [],
        waiting: [],
        waitingTotal: 0,
        started: [],
      },
    }).text;
    expect(withConflict).toContain('List and settle them with rbook_db(action="conflicts").');
  });

  /** Every section at its cap, the profile at its allowance, and a shared record with every part. */
  function fullModel(): DigestV2Model {
    const rows = (kind: string, n: number, size: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${kind}:${i + 1}`,
        text: `${'word '.repeat(size)}.`,
        projectId: null,
        date: '2026-10-16',
      }));
    return {
      project: { name: 'P'.repeat(70), level: 'builder' },
      localProjectId: null,
      sprint: {
        id: 'sprint-1',
        title: 'T'.repeat(200),
        focus: null,
        status: 'Active',
        projectId: null,
      },
      profile: { text: 'p'.repeat(1100), overCap: false } as DigestV2Model['profile'],
      stepUp: null,
      rules: rows('l', 4, 40),
      decisions: { rows: rows('d', 8, 40), total: 8 },
      learnings: { rows: rows('l', 3, 40), total: 3 },
      work: rows('m', 5, 40),
      feedback: 'f'.repeat(100),
      shared: {
        conflicts: Array.from({ length: 9 }, (_, i) => `missions m-${i}'s objective (2 values)`),
        states: ['s-1 and s-2 are all open; close or plan all but one.'],
        waiting: ['2 held until what they wait for arrives, which a sync brings (the first ...)'],
        waitingTotal: 2,
        started: ['m-1, started by someone'],
      },
    };
  }
  const SHORT_FORM =
    'Shared record: 9 field(s) in conflict, 1 state(s) need a person, 2 change(s) not live yet; rbook_db(action="conflicts").';

  it('in the room the rest of a full digest leaves, the section shrinks to its counts', () => {
    const text = renderDigestV2(fullModel()).text;
    expect(text.length).toBeLessThanOrEqual(DIGEST_V2_CAP);
    expect(text).toContain(SHORT_FORM);
  });

  // s97-m14 (critics, round 1): a removal leads the sync line, so the 300-character cut keeps it,
  // and the short form names it before any count.
  it("a member's removal leads the sync line, and the short form names it first", () => {
    const removed =
      "the dashboard: said this copy's member was removed (first said 3 min ago): what this copy sends is set aside, and counts only if the owner shares the project with it again; synced 3 min ago, 0 pending; failing since 2 min ago (2 tries); last error: " +
      'e'.repeat(160);
    const shared = {
      conflicts: [],
      states: [],
      waiting: [],
      waitingTotal: 0,
      started: [],
      peers: [removed],
      syncErrors: 1,
      removed: true,
    };
    const base = fullModel();
    const roomy = renderDigestV2({
      ...base,
      rules: [],
      decisions: { rows: [], total: 0 },
      learnings: { rows: [], total: 0 },
      work: [],
      profile: null,
      shared,
    }).text;
    expect(roomy).toContain(
      "• Sync: the dashboard: said this copy's member was removed (first said 3 min ago)"
    );
    const tight = renderDigestV2({
      ...base,
      shared: { ...base.shared!, peers: shared.peers, syncErrors: 1, removed: true },
    }).text;
    expect(tight).toContain(
      "Shared record: this copy's member was removed from the project, 9 field(s) in conflict"
    );
  });

  it('with drafts pending too, both show, and the recent decisions give up the room', () => {
    // rbook_review's answer carries no shared-record notice, so its digest must not leave the
    // section out; nor may the section push out the drafts the operator's answer needs.
    const target = {
      projectRoot: ['', 'Users', 'someone', `${'deep/'.repeat(12)}project`].join('/'),
      resolvedBy: 'explicit' as const,
    };
    const drafts = [1, 2, 3].map((id) => ({ id, kind: 'decision', text: 'A choice to approve.' }));
    const text = renderDigestV2({ ...fullModel(), drafts }, target).text;
    expect(text.length).toBeLessThanOrEqual(DIGEST_V2_CAP);
    expect(text).toContain(SHORT_FORM);
    expect(text).toContain('Pending drafts:');
    // A solo store, with no shared record, keeps the recent decisions at their full room.
    const solo = renderDigestV2({ ...fullModel(), shared: null, drafts }, target).text;
    const decisions = (digest: string) =>
      digest.split('\n\n').find((part) => part.startsWith('Recent decisions:')) ?? '';
    expect(decisions(text).length).toBeLessThan(decisions(solo).length);
  });
});

describe('recall from a shared copy marks a decision whose value is provisional', () => {
  it('the first prompt, later prompts and reasonbook relevant each name the field in conflict', async () => {
    const { owner, id } = await contested();
    const first = recallFirstPrompt(dbOf(owner.root), 'ledger place');
    expect(first.items).toEqual([expect.objectContaining({ id, conflicts: ['status'] })]);
    const shown = renderFirstPrompt(first);
    expect(shown.text).toContain(`d:${id} [in conflict: status] `);
    expect(shown.text).toContain(
      'A value in conflict is provisional: rbook_db(action="conflicts").'
    );
    // A later prompt needs three of its words in the decision (LATER_MIN_KEYWORD_MATCHES).
    const later = recallLaterPrompt(dbOf(owner.root), 'keep the ledger in one place', []);
    expect(later.items).toEqual([expect.objectContaining({ id, conflicts: ['status'] })]);
    expect(keywordRelevant(dbOf(owner.root), 'ledger place', 5)).toEqual([
      expect.objectContaining({ kind: 'decision', id, conflicts: ['status'] }),
    ]);
  }, 60000);

  it('at every room the hook can give recall, five marked decisions fit, each marked', () => {
    // The longest field a decision records, on ids from a late block: the widest mark there is.
    const longest = [...RECORD_COLUMNS.strategic_decisions.recorded].sort(
      (a, b) => b.length - a.length
    )[0];
    const items = Array.from({ length: 5 }, (_, i) => ({
      kind: 'decision' as const,
      id: 99000001 + i,
      status: 'active',
      projectId: null,
      text: 'word '.repeat(80),
      truncated: false,
      retrievalSource: 'keyword' as const,
      via: [],
      conflicts: [longest, 'status', 'superseded_by'],
    }));
    const result = { items, localProjectId: null, warnings: [], available: true };
    for (let cap = MIN_RECALL_ROOM; cap <= HOOK_CAPS.prompt!; cap++) {
      const shown = renderFirstPrompt(result, cap).text;
      expect(shown.length).toBeLessThanOrEqual(cap);
      expect(shown).toContain(CONFLICT_POINTER);
      for (const item of items) expect(shown).toMatch(new RegExp(`d:${item.id} \\[in conflict`));
    }
    expect(renderFirstPrompt(result).text).toContain(`[in conflict: ${longest} +2] `);
  });

  it('a solo store marks nothing', async () => {
    useMachine(fixture.tmp, 'solo-machine');
    const solo = project(fixture.tmp, 'solo');
    await call('rbook_decisions', {
      action: 'record',
      content: 'Keep the ledger in one place.',
      projectRoot: solo,
    });
    const first = recallFirstPrompt(dbOf(solo), 'ledger place');
    expect(first.items).toHaveLength(1);
    expect(first.items[0].conflicts).toBeUndefined();
    expect(renderFirstPrompt(first).text).not.toContain('in conflict');
  }, 60000);
});
