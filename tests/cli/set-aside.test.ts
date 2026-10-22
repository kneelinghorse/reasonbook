// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The set-aside CLI previews one copy before the person's explicit application.
// ABOUTME: Real recorded stores prove the preview is inert and applying cuts only the named copy.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import { runCli } from '../../src/cli';
import { replicaMarks } from '../../src/tools/rbook/record-apply';
import { mergeContext } from '../../src/tools/rbook/record-standing';
import { recordExchanged } from '../../src/tools/rbook/record-peers';
import { withSyncLock } from '../../src/tools/rbook/record-sync-trigger';
import { dbOf, replicaFixture, useMachine, type ReplicaFixture } from '../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, read, type Copy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-cli-set-aside-');
});
afterEach(() => fixture.restore());

async function command(copy: Copy, args: readonly string[]) {
  useMachine(fixture.tmp, copy.machine);
  const stdout: string[] = [],
    stderr: string[] = [];
  const code = await runCli(['set-aside', ...args], {
    cwd: copy.root,
    env: { ...process.env },
    readStdin: async () => '',
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}
const log = (copy: Copy) =>
  read(
    copy,
    'SELECT change_id, kind, entity_id, value FROM record_changes ORDER BY replica_id, replica_seq'
  );

it('previews the named owner copy and its last exchange without recording a cut', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const other = await joinedCopy(fixture.tmp, owner, 'other', 'Owner');
  await onCopy(fixture.tmp, owner, (client) =>
    recordExchanged(client, other.replicaId, { marks: {} })
  );
  const before = log(owner);
  const result = await command(owner, ['--replica', other.replicaId]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(other.replicaId);
  expect(result.stdout).toMatch(/Owner/);
  expect(result.stdout).toMatch(/block/i);
  expect(result.stdout).toMatch(/last exchange/i);
  expect(result.stdout).toMatch(/--yes/);
  expect(log(owner)).toEqual(before);
  expect(
    await onCopy(
      fixture.tmp,
      owner,
      (client) => mergeContext(client).members.get(other.replicaId)?.cut
    )
  ).toBeUndefined();
});

it('requires --yes to apply and leaves another copy of the same person uncut', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const other = await joinedCopy(fixture.tmp, owner, 'other', 'Owner');
  const kept = await joinedCopy(fixture.tmp, owner, 'kept', 'Owner');
  const cut = await onCopy(
    fixture.tmp,
    owner,
    (client) => replicaMarks(client)[other.replicaId] ?? 0
  );
  const result = await command(owner, ['--replica', other.replicaId, '--yes']);
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(/set aside/i);
  expect(
    await onCopy(
      fixture.tmp,
      owner,
      (client) => mergeContext(client).members.get(other.replicaId)?.cut
    )
  ).toBe(cut);
  expect(
    await onCopy(
      fixture.tmp,
      owner,
      (client) => mergeContext(client).members.get(kept.replicaId)?.cut
    )
  ).toBeUndefined();
});

it('refuses an unnamed replica before making a member change', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const before = log(owner);
  const result = await command(owner, ['--yes']);
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/--replica/);
  expect(log(owner)).toEqual(before);
});

it.each([
  ['--replica'],
  ['--replica=one', '--replica=two', '--yes'],
  ['--replica=one', '--yes=false'],
  ['one', '--yes'],
])('refuses ambiguous or incomplete arguments %j before recording a cut', async (...args) => {
  const owner = await ownerCopy(fixture.tmp);
  const before = log(owner);
  const result = await command(owner, args);
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/--replica/);
  expect(log(owner)).toEqual(before);
});

it('does not race a sync or share that already owns this copy lock', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const other = await joinedCopy(fixture.tmp, owner, 'other', 'Owner');
  useMachine(fixture.tmp, owner.machine);
  const before = log(owner);
  const result = await withSyncLock(dbOf(owner.root), () =>
    command(owner, ['--replica', other.replicaId, '--yes'])
  );
  expect(result?.code).toBe(1);
  expect(result?.stderr).toMatch(/sync.*running/i);
  expect(log(owner)).toEqual(before);
});

it('reports a failed cut without a success message or a partial member change', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const other = await joinedCopy(fixture.tmp, owner, 'other', 'Owner');
  await onCopy(fixture.tmp, owner, (client) => {
    const installed = client.execute(`CREATE TRIGGER fail_set_aside BEFORE INSERT ON record_changes
      WHEN NEW.kind = 'member' BEGIN SELECT RAISE(ABORT, 'injected cut write failure'); END`);
    expect(installed.success).toBe(true);
  });
  const before = log(owner);
  const result = await command(owner, ['--replica', other.replicaId, '--yes']);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toBe('');
  expect(log(owner)).toEqual(before);
  expect(
    await onCopy(
      fixture.tmp,
      owner,
      (client) => mergeContext(client).members.get(other.replicaId)?.cut
    )
  ).toBeUndefined();
});
