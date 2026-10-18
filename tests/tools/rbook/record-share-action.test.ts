// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m13 (design §s96-m13 items 1, 6) — sharing names its owner by an author name and refuses a store git tracks;
// ABOUTME: a shared copy refuses a restore; reasonbook copy makes a store that joins, and never overwrites one.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { runCli } from '../../../src/cli';
import type { CliIo } from '../../../src/cli/core';
import { readUserAuthor, writeUserAuthor } from '../../../src/intelligence/user-author';
import { rbookDbRestore } from '../../../src/tools/rbook/rbook-db-restore';
import { answerJoin, applyJoin, requestJoin } from '../../../src/tools/rbook/record-join';
import { inviteMember } from '../../../src/tools/rbook/record-membership';
import { shareProject } from '../../../src/tools/rbook/record-share-action';
import {
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { onCopy, ownerCopy, read } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-share-');
});
afterEach(() => fixture.restore());

const share = (root: string, machine: string, options: { authorName?: string } = {}) =>
  onCopy(fixture.tmp, { root, machine }, (client) => shareProject(client, root, options), {
    replicaCheck: false,
  });

async function cli(argv: string[]) {
  let stdout = '';
  const stderr: string[] = [];
  const io: CliIo = {
    env: process.env,
    cwd: fixture.tmp,
    readStdin: async () => '',
    stdout: (text) => {
      stdout += text;
    },
    stderr: (line) => {
      stderr.push(line);
    },
  };
  return { code: await runCli(argv, io), stdout, stderr };
}

describe('share', () => {
  it("makes the owner's copy the first authority in block 0, named by its author name, once", async () => {
    useMachine(fixture.tmp, 'air');
    writeUserAuthor('Derek');
    const root = project(fixture.tmp, 'p');
    const shared = await share(root, 'air');
    expect(shared.data).toMatchObject({ block: 0, owner: 'Derek' });
    expect(
      read(
        { root },
        "SELECT json_extract(value, '$.owner') AS owner FROM record_changes WHERE kind = 'baseline'"
      )
    ).toEqual([{ owner: 'Derek' }]);
    expect((await share(root, 'air')).error?.message).toMatch(/shared already/);
  }, 120000);

  it('asks for an author name when none is set, and authorName sets it: no dashboard account needed', async () => {
    useMachine(fixture.tmp, 'air');
    const root = project(fixture.tmp, 'p');
    expect((await share(root, 'air')).error).toMatchObject({
      message: expect.stringMatching(/none is set here/),
      suggestion: expect.stringMatching(/authorName|reasonbook config author/),
    });
    expect((await share(root, 'air', { authorName: 'Derek' })).data).toMatchObject({
      owner: 'Derek',
    });
    expect(readUserAuthor()).toBe('Derek');
  }, 120000);

  it('a project whose git repository tracks its store cannot be shared', async () => {
    useMachine(fixture.tmp, 'air');
    writeUserAuthor('Derek');
    const root = project(fixture.tmp, 'p');
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'add', '-f', path.join('rbook', 'db', 'rbook.sqlite')]);
    expect((await share(root, 'air')).error).toMatchObject({
      code: 'RECORD_WRITE_REFUSED',
      message: expect.stringMatching(/tracks its store \(rbook\/db\/rbook\.sqlite\)/),
      suggestion: expect.stringMatching(/git rm --cached/),
    });
    expect(read({ root }, "SELECT count(*) AS n FROM metadata WHERE key = 'replica_id'")).toEqual([
      { n: 0 },
    ]);
  }, 120000);
});

describe('restore and copy on a shared record', () => {
  it('a copy of a shared record refuses a restore, which would lose what it has not synced', async () => {
    const owner = await ownerCopy(fixture.tmp);
    useMachine(fixture.tmp, owner.machine);
    const refused = await rbookDbRestore({
      projectRoot: owner.root,
      snapshotId: 'any',
      confirm: true,
    });
    expect(refused.error).toMatchObject({
      code: 'RECORD_WRITE_REFUSED',
      message: expect.stringMatching(/copy of a shared record/),
    });
  }, 120000);

  it('reasonbook copy makes a store that joins, and never writes over one already there', async () => {
    const owner = await ownerCopy(fixture.tmp);
    await onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name: 'Darryl' }));
    useMachine(fixture.tmp, owner.machine);
    const dest = path.join(fixture.tmp, 'carried');
    const made = await cli(['copy', '--to', dest, '--project-root', owner.root]);
    expect(made).toMatchObject({ code: 0, stderr: [] });
    expect(fs.existsSync(dbOf(dest))).toBe(true);
    expect(
      (await cli(['copy', '--to', dest, '--project-root', owner.root])).stderr.join(' ')
    ).toMatch(/already holds a store/);
    const zip = { root: dest, machine: 'machine-studio' };
    useMachine(fixture.tmp, zip.machine);
    writeUserAuthor('Darryl');
    const request = await onCopy(fixture.tmp, zip, (client) => requestJoin(client), {
      replicaCheck: false,
    });
    const answer = await onCopy(fixture.tmp, owner, (client) =>
      answerJoin(client, request.data!, 'Darryl')
    );
    const applied = await onCopy(fixture.tmp, zip, (client) => applyJoin(client, answer.data!), {
      replicaCheck: false,
    });
    expect(applied.data).toMatchObject({ block: 1, member: 'Darryl' });
  }, 120000);
});
