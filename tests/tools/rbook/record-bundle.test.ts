// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m13 (ADR s96 §7) — a bundle carries a shared record's changes by file: two carries leave both copies
// ABOUTME: with one record, a damaged or edited file is refused whole, and a duplicate import changes nothing.
import { localCopyReport } from '../../../src/tools/rbook/record-copy-report';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { runCli } from '../../../src/cli';
import type { CliIo } from '../../../src/cli/core';
import { replicaMarks } from '../../../src/tools/rbook/record-apply';
import {
  importBundle,
  readBundle,
  writeBundle,
  type Bundle,
  type BundleImport,
} from '../../../src/tools/rbook/record-bundle';
import type { RbookToolResult } from '../../../src/tools/rbook/types';
import { RECORD_COLUMNS, RECORDED_TABLES } from '../../../src/tools/rbook/record-columns';
import { removeMember } from '../../../src/tools/rbook/record-membership';
import {
  call,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import {
  backUp,
  joinedCopy,
  memberCopy,
  onCopy,
  ownerCopy,
  read,
  syncCopies,
  type Copy,
} from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-bundle-');
});
afterEach(() => fixture.restore());

async function ok(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

/** A bundle written on `from` for `to`, as of what `to` holds, then carried as text. */
async function carry(from: Copy, to: Copy): Promise<string> {
  const since = await onCopy(fixture.tmp, to, (client) => replicaMarks(client));
  return JSON.stringify(
    await onCopy(fixture.tmp, from, (client) => writeBundle(client, since, localCopyReport()))
  );
}

async function land(copy: Copy, text: string): Promise<RbookToolResult<BundleImport>> {
  return onCopy(fixture.tmp, copy, (client) => {
    const bundle = readBundle(text);
    return bundle.success
      ? importBundle(client, bundle.data!)
      : { success: false, error: bundle.error };
  });
}

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

describe('a bundle between a member and the owner', () => {
  it('two carries, the member to the owner and back, leave one record and a conflict on both', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const id = (await ok(owner, 'rbook_decisions', { action: 'record', content: 'Contested.' }))
      .data!.decisionId!;
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    expect((await land(member, await carry(owner, member))).success).toBe(true);
    await ok(owner, 'rbook_decisions', { action: 'update', decisionId: id, status: 'archived' });
    await ok(member, 'rbook_decisions', { action: 'update', decisionId: id, status: 'stale' });
    await ok(member, 'rbook_decisions', { action: 'record', content: 'By bundle.' });
    const outbound = await carry(member, owner);
    // The owner judges each of the member's transactions it receives, once.
    const memberTxns = new Set(
      (JSON.parse(outbound) as Bundle).changes
        .filter((change) => change.replica_id === member.replicaId)
        .map((change) => change.txn_id)
    );
    const toOwner = await land(owner, outbound);
    expect(memberTxns.size).toBeGreaterThanOrEqual(2);
    expect(toOwner.data).toMatchObject({ judged: memberTxns.size, transactions: memberTxns.size });
    expect((await land(member, await carry(owner, member))).success).toBe(true);
    expect(recorded(member)).toEqual(recorded(owner));
    for (const copy of [owner, member])
      expect(read(copy, 'SELECT field FROM record_conflicts')).toEqual([{ field: 'status' }]);
  }, 120000);

  it('a bundle imported twice changes nothing the second time', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await ok(member, 'rbook_decisions', { action: 'record', content: 'Once.' });
    const text = await carry(member, owner);
    expect((await land(owner, text)).data!.stored).toBeGreaterThan(0);
    const before = read(owner, 'SELECT count(*) AS n FROM record_changes');
    expect((await land(owner, text)).data).toMatchObject({ stored: 0, judged: 0 });
    expect(read(owner, 'SELECT count(*) AS n FROM record_changes')).toEqual(before);
  }, 120000);

  it('a bundle that starts past what this copy holds is held until the rest arrives', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await ok(owner, 'rbook_decisions', { action: 'record', content: 'First.' });
    const first = await carry(owner, member);
    await ok(owner, 'rbook_decisions', { action: 'record', content: 'Second.' });
    // Written as if the member already held the first: it starts after a gap.
    const marks = await onCopy(fixture.tmp, owner, (client) => replicaMarks(client));
    const ahead = { ...marks, [owner.replicaId]: marks[owner.replicaId] - 1 };
    const second = JSON.stringify(
      await onCopy(fixture.tmp, owner, (client) => writeBundle(client, ahead, localCopyReport()))
    );
    expect((await land(member, second)).data!.held).toBeGreaterThan(0);
    expect(
      read(member, "SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = 'Second.'")
    ).toEqual([{ n: 0 }]);
    expect((await land(member, first)).data!.held).toBe(0);
    expect(
      read(
        member,
        "SELECT count(*) AS n FROM strategic_decisions WHERE decision_text IN ('First.', 'Second.')"
      )
    ).toEqual([{ n: 2 }]);
  }, 120000);
});

describe('a bundle refused whole', () => {
  it('an edited bundle no longer matches its content hash, and nothing of it is stored', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await ok(member, 'rbook_decisions', { action: 'record', content: 'Honest.' });
    const bundle = JSON.parse(await carry(member, owner)) as Bundle;
    const edited = {
      ...bundle,
      changes: bundle.changes.map((change) => ({
        ...change,
        value: change.value?.replace('Honest.', 'Edited.') ?? null,
      })),
    };
    const before = read(owner, 'SELECT count(*) AS n FROM record_changes');
    expect((await land(owner, JSON.stringify(edited))).error).toMatchObject({
      code: 'RECORD_EXCHANGE_REFUSED',
      message: expect.stringMatching(/does not match its content hash/),
    });
    expect((await land(owner, 'not json')).error?.message).toMatch(/not JSON/);
    expect(read(owner, 'SELECT count(*) AS n FROM record_changes')).toEqual(before);
  }, 120000);

  it('a bundle between two members is refused: a member syncs only with the owner', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const a = await memberCopy(fixture.tmp, owner, 'a', 1);
    const b = await memberCopy(fixture.tmp, owner, 'b', 2);
    expect((await land(b, await carry(a, b))).error).toMatchObject({
      code: 'RECORD_EXCHANGE_REFUSED',
      suggestion: "Sync with the owner's copy.",
    });
  }, 120000);

  it('a restored copy is told it is restored before anything about the bundle it was given', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const a = await memberCopy(fixture.tmp, owner, 'a', 1);
    const b = await memberCopy(fixture.tmp, owner, 'b', 2);
    const restore = await backUp(fixture.tmp, b);
    await ok(b, 'rbook_decisions', { action: 'record', content: 'Lost with the folder.' });
    restore();
    // Opened without the copy check, as reasonbook sync --bundle-in opens it: the import checks first.
    const unchecked = { replicaCheck: false };
    const since = await onCopy(fixture.tmp, b, (client) => replicaMarks(client), unchecked);
    const bundle = await onCopy(fixture.tmp, a, (client) =>
      writeBundle(client, since, localCopyReport())
    );
    const landed = await onCopy(
      fixture.tmp,
      b,
      (client) => importBundle(client, bundle),
      unchecked
    );
    expect(landed.error?.code).toBe('REPLICA_RESTORED');
  }, 120000);
});

describe('bundles across a move or a removal (s96-m13 build-time critics)', () => {
  const unchecked = <T>(copy: Copy, use: Parameters<typeof onCopy<T>>[2]) =>
    onCopy(fixture.tmp, copy, use, { replicaCheck: false });

  it("a bundle one move ahead, from a copy that is no owner's copy in either view, is refused", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    // The studio's copy says it follows a move this copy never took, to an owner copy neither knows.
    const bundle = await unchecked(studio, (client) => writeBundle(client, {}, localCopyReport()));
    const ahead: Bundle = {
      ...bundle,
      from: { ...bundle.from, epoch: bundle.from.epoch + 1, authority: 'someone-else' },
    };
    const refused = await unchecked(owner, (client) => importBundle(client, ahead));
    expect(refused.error?.message).toMatch(/is not the owner's copy in either view/);
  }, 240000);

  it("a copy the bundle's writer shows as removed takes in nothing from it", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    await unchecked(owner, (client) => removeMember(client, 'Darryl'));
    await ok(owner, 'rbook_decisions', { action: 'record', content: 'After the removal.' });
    const refused = await land(studio, await carry(owner, studio));
    expect(refused.error?.message).toMatch(/shows this copy's member as removed/);
    expect(
      read(studio, "SELECT id FROM strategic_decisions WHERE decision_text = 'After the removal.'")
    ).toEqual([]);
  }, 240000);

  it('a bundle --for a member who was removed, or for a name that is no member, is not written', async () => {
    const owner = await ownerCopy(fixture.tmp);
    await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await unchecked(owner, (client) => removeMember(client, 'Darryl'));
    const out = path.join(fixture.tmp, 'bundle.json');
    for (const [name, said] of [
      ['Darryl', /Darryl was removed, so their copy receives nothing new/],
      ['Nobody', /Nobody is not a member of this project/],
    ] as const) {
      const stderr: string[] = [];
      const io: CliIo = {
        env: process.env,
        cwd: fixture.tmp,
        readStdin: async () => '',
        stdout: () => undefined,
        stderr: (line) => {
          stderr.push(line);
        },
      };
      useMachine(fixture.tmp, owner.machine);
      const code = await runCli(
        ['sync', '--bundle-out', out, '--for', name, '--project-root', owner.root],
        io
      );
      expect({ code, said: stderr.join(' ') }).toEqual({
        code: 1,
        said: expect.stringMatching(said),
      });
      expect(fs.existsSync(out)).toBe(false);
    }
  }, 240000);
});
